// gm-typemaster / analyzer.js
// Lightweight GML scanner that extracts *type facts* that GMEdit does not infer on its own:
//   - struct literals  ({ hp: 100, name: "orc" })  -> synthesized field lists
//   - function return types (first `return <expr>`) -> usable at call sites
//   - plain assignments (var x = ... / x = ...)     -> variable -> type
// Runs in both the GMEdit renderer and Node (for tests); no dependency on the editor.
var TypeMasterAnalyzer = (function () {
	"use strict";

	var KEYWORDS = Object.create(null);
	("if else for while do until repeat switch case default break continue return " +
		"var static let const function constructor new delete with try catch finally throw " +
		"and or not xor mod div true false undefined self other all noone global " +
		"begin end then else").split(" ").forEach(function (k) { if (k) KEYWORDS[k] = true; });

	// GameMaker functions that hand back an instance id, mapped to the argument
	// that tells us which object it is. Index is 0-based.
	var INSTANCE_CALLS = Object.create(null);
	INSTANCE_CALLS["instance_create"] = 2;
	INSTANCE_CALLS["instance_create_layer"] = 3;
	INSTANCE_CALLS["instance_create_depth"] = 3;
	INSTANCE_CALLS["instance_find"] = 0;
	INSTANCE_CALLS["instance_nearest"] = 2;
	INSTANCE_CALLS["instance_furthest"] = 2;
	INSTANCE_CALLS["instance_position"] = 2;
	INSTANCE_CALLS["instance_place"] = 2;
	INSTANCE_CALLS["instance_position_list"] = 2;
	INSTANCE_CALLS["instance_place_list"] = 2;

	function isIdStart(c) {
		var x = c.charCodeAt(0);
		return (x >= 65 && x <= 90) || (x >= 97 && x <= 122) || x === 95;
	}
	function isIdPart(c) {
		var x = c.charCodeAt(0);
		return (x >= 65 && x <= 90) || (x >= 97 && x <= 122) || x === 95 || (x >= 48 && x <= 57);
	}
	function isDigit(c) { var x = c.charCodeAt(0); return x >= 48 && x <= 57; }
	function isSpace(c) { var x = c.charCodeAt(0); return x === 32 || x === 9 || x === 10 || x === 13 || x === 12; }

	// Blank out comments and string *contents* while keeping the source length and the quote chars.
	// That way `"..."` still reads as a string literal but braces inside it cannot confuse the scanner.
	function mask(text) {
		var n = text.length, out = text.split(""), i = 0;
		while (i < n) {
			var c = text.charAt(i), d = text.charAt(i + 1);
			if (c === "/" && d === "/") {
				while (i < n && text.charAt(i) !== "\n") { out[i] = " "; i++; }
			} else if (c === "/" && d === "*") {
				out[i] = " "; out[i + 1] = " "; i += 2;
				while (i < n && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) {
					if (text.charAt(i) !== "\n") out[i] = " ";
					i++;
				}
				if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2; }
			} else if (c === '"' || c === "'") {
				var q = c;
				i++;
				while (i < n) {
					var ch = text.charAt(i);
					if (ch === "\\") { out[i] = " "; i++; if (i < n) { out[i] = " "; i++; } continue; }
					if (ch === q || ch === "\n") break;
					out[i] = " "; i++;
				}
				if (i < n && text.charAt(i) === q) i++;
			} else {
				i++;
			}
		}
		return out.join("");
	}

	function matchClose(s, i) {
		var open = s.charAt(i), close;
		if (open === "{") close = "}";
		else if (open === "(") close = ")";
		else if (open === "[") close = "]";
		else return -1;
		var depth = 0, n = s.length;
		while (i < n) {
			var c = s.charAt(i);
			if (c === open) depth++;
			else if (c === close) { depth--; if (depth === 0) return i; }
			i++;
		}
		return -1;
	}

	function analyze(text, options) {
		var masked = mask(text);
		var n = masked.length;

		// Known object resources, supplied by the editor. When absent we fall back to the
		// `obj_` naming convention so that the analyzer still works standalone.
		var objects = null;
		var objectCount = 0;
		if (options && options.objects && options.objects.length) {
			objects = Object.create(null);
			for (var oi = 0; oi < options.objects.length; oi++) {
				objects[options.objects[oi]] = true;
				objectCount++;
			}
		}

		// Cross-file function return types, supplied by the editor as portable trees:
		//   fn -> { struct: [{name, type}] } | { obj: "obj_x" } | { nm: "Boss" }
		// A tree never references struct ids, so it can be materialized into this file's
		// own struct table (which keeps every downstream injection path unchanged).
		var EXT = (options && options.external) || null;
		var extBuilt = Object.create(null);

		// Cross-file `global.NAME = ...` shapes, same portable tree format as EXT.
		// GMEdit knows the *name* of a global (it lists it after `global.`), but never the
		// shape of its value, so `global.CONFIG.` has nothing to show without this.
		var GLOB = (options && options.globals) || null;

		function isObjectName(name) {
			if (objects != null) {
				if (objects[name]) return true;
				if (objectCount > 0) return false;
			}
			return /^obj_/i.test(name);
		}

		// ---- line index -------------------------------------------------
		var lineStarts = [0];
		for (var li = 0; li < n; li++) if (text.charCodeAt(li) === 10) lineStarts.push(li + 1);
		function rowOf(pos) {
			var lo = 0, hi = lineStarts.length - 1;
			while (lo < hi) {
				var mid = (lo + hi + 1) >> 1;
				if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
			}
			return lo;
		}

		// ---- explicit `/// @is {type}` hints -----------------------------
		// GMEdit's own @is only covers struct/instance/global fields. We honour it for local
		// variables too: same line (`var x = ...; /// @is {T}`) or the line right above.
		var lineHints = Object.create(null);
		var textLines = text.split("\n");
		var reIs = /\/\/\/\s*@is\s*\{([^}]+)\}/;
		var hintRows = [];
		for (var hli = 0; hli < textLines.length; hli++) {
			var hm = reIs.exec(textLines[hli]);
			if (hm == null) continue;
			var hintName = hm[1].replace(/<.*$/, "").trim();
			if (!hintName || !isIdStart(hintName.charAt(0))) continue;
			lineHints[hli] = hintName;
			// Only a comment standing on its own line carries over to the next line.
			// A trailing `var x = y; /// @is {T}` describes that statement only.
			if (textLines[hli].slice(0, hm.index).trim() === "") hintRows.push(hli);
		}
		// A hint on its own line applies to the next line, unless that line has its own hint.
		for (var hk = 0; hk < hintRows.length; hk++) {
			var hrow = hintRows[hk];
			var next = hrow + 1;
			if (next >= textLines.length || lineHints[next] != null) continue;
			if (textLines[next].trim() === "") continue;
			lineHints[next] = lineHints[hrow];
		}

		// ---- state ------------------------------------------------------
		var structByPos = Object.create(null);   // openPos -> id (1-based)
		var structPos = [];                      // id-1 -> openPos
		var structs = [];                        // id-1 -> [{name, type}]
		var returns = Object.create(null);       // fnName -> type
		var localTypes = Object.create(null);    // varName -> type (approximate, cross-scope)
		var retRanges = [];
		var rawAssigns = [];
		var globalAssigns = [];      // [{ name, s, e }]  global.NAME = <expr>
		var globalFieldAdds = [];    // [{ base, field, s, e }]  global.NAME.field = <expr>

		// type value shapes: { st: id } | { nm: "number" } | null
		function structAt(openPos) {
			var id = structByPos[openPos];
			if (id == null) {
				structPos.push(openPos);
				id = structPos.length;
				structByPos[openPos] = id;
				structs[id - 1] = null;
			}
			return { st: id };
		}

		function readWord(from, to) {
			if (from >= to || !isIdStart(masked.charAt(from))) return null;
			var i = from;
			while (i < to && isIdPart(masked.charAt(i))) i++;
			return { word: masked.slice(from, i), end: i };
		}

		function skipSpace(from, to) {
			var i = from;
			while (i < to && isSpace(masked.charAt(i))) i++;
			return i;
		}

		// Materialize an externally supplied type tree into this file's struct table, so the
		// rest of the pipeline (registration, import mirroring, nested access) stays as is.
		function newStruct() {
			var id = structs.length + 1;
			structs.push([]);
			structPos.push(-1);          // keep `structs` and `structPos` aligned
			return id;
		}

		function materialize(spec, depth) {
			if (spec == null || depth > 10) return null;
			if (spec.struct != null) {
				var id = newStruct();
				var arr = structs[id - 1];
				for (var fi = 0; fi < spec.struct.length; fi++) {
					var f = spec.struct[fi];
					arr.push({ name: f.name, type: materialize(f.type, depth + 1) });
				}
				return { st: id };
			}
			if (spec.obj != null) return { obj: spec.obj };
			if (spec.nm) return { nm: spec.nm, ex: spec.ex };
			if (spec.ext) return extType(spec.ext, depth + 1);
			return null;
		}

		function extType(fn, depth) {
			if (EXT == null) return null;
			if (depth == null) depth = 0;
			if (Object.prototype.hasOwnProperty.call(extBuilt, fn)) return extBuilt[fn];
			var spec = EXT[fn];
			if (spec == null) return null;
			if (depth > 10) return { nm: "struct" };
			var res = materialize(spec, depth);
			extBuilt[fn] = res;
			return res;
		}

		function typeOf(s, e) {
			var i = skipSpace(s, e);
			if (i >= e) return null;
			var c = masked.charAt(i);
			if (c === "{") return structAt(i);
			if (c === '"' || c === "'") return { nm: "string" };
			if (c === "@" || c === "$") {
				var j = skipSpace(i + 1, e);
				if (masked.charAt(j) === '"') return { nm: "string" };
				return null;
			}
			if (c === "[") return { nm: "array" };
			if (c === "(") { var in1 = skipSpace(i + 1, e); return typeOf(in1, e); }
			if (c === "-" || c === "+" || c === "!") {
				var k = skipSpace(i + 1, e);
				if (isDigit(masked.charAt(k)) || masked.charAt(k) === ".") return { nm: "number" };
				return typeOf(k, e);
			}
			if (c === "." && isDigit(masked.charAt(i + 1))) return { nm: "number" };
			if (isDigit(c)) return { nm: "number" };
			if (!isIdStart(c)) return null;

			var w = readWord(i, e);
			if (w == null) return null;
			var word = w.word, p = w.end;
			if (word === "new") {
				var w2 = readWord(skipSpace(p, e), e);
				return w2 ? { nm: w2.word } : null;
			}
			if (word === "true" || word === "false") return { nm: "bool" };
			if (word === "undefined") return { nm: "undefined" };
			if (word === "function") return null;
			var q = skipSpace(p, e);
			if (masked.charAt(q) === "(") {                                 // call
				var inst = instanceTypeFromCall(word, q, e);
				if (inst) return inst;
				// A function defined in this file wins; otherwise fall back to the
				// project-wide index built from other files.
				return returns[word] || extType(word);
			}
			if (isObjectName(word)) return { obj: word };                   // object asset used as a value
			// `a.b`: we know the type of `a`, not of its member. Returning that type here
			// would tag the field with the wrong type, so leave it unknown instead.
			if (masked.charAt(q) === ".") return null;
			return localTypes[word] || null;                                // plain reference
		}

		// Split "a, b, c" inside a call and return the range of argument `idx`.
		function nthArg(s, e, idx) {
			var k = s, start = s, dP = 0, dB = 0, dC = 0, ai = 0;
			while (k < e) {
				var c = masked.charAt(k);
				if (c === "(") dP++;
				else if (c === ")") dP--;
				else if (c === "[") dB++;
				else if (c === "]") dB--;
				else if (c === "{") dC++;
				else if (c === "}") dC--;
				else if (c === "," && dP === 0 && dB === 0 && dC === 0) {
					if (ai === idx) return { s: start, e: k };
					ai++;
					start = k + 1;
				}
				k++;
			}
			if (ai === idx) return { s: start, e: e };
			return null;
		}

		// instance_create_layer(x, y, layer, obj_enemy) -> { obj: "obj_enemy" }
		function instanceTypeFromCall(word, lp, limit) {
			var idx = INSTANCE_CALLS[word];
			if (idx == null) return null;
			var close = matchClose(masked, lp);
			if (close < 0) return null;
			var end = close < limit ? close : limit;
			var ar = nthArg(lp + 1, end, idx);
			if (ar == null) return null;
			var t = typeOf(ar.s, ar.e);
			if (t && t.obj) return t;
			return null;
		}

		function scanExprEnd(from) {
			var dP = 0, dB = 0, dC = 0, k = from;
			while (k < n) {
				var ch = masked.charAt(k);
				if (ch === "(") dP++;
				else if (ch === ")") { if (dP === 0 && dB === 0 && dC === 0) return k; dP--; }
				else if (ch === "[") dB++;
				else if (ch === "]") { if (dB === 0 && dC === 0) return k; dB--; }
				else if (ch === "{") dC++;
				else if (ch === "}") { if (dC === 0) return k; dC--; }
				else if (dP === 0 && dB === 0 && dC === 0 && (ch === ";" || ch === "\n")) return k;
				k++;
			}
			return n;
		}

		// ---- 1. function return types -----------------------------------
		function findFirstReturn(from, to) {
			var k = from;
			while (k < to) {
				var c = masked.charAt(k);
				if (!isIdStart(c)) { k++; continue; }
				var w = readWord(k, to);
				if (w == null) { k++; continue; }
				if (w.word === "function") {          // skip nested function bodies
					var lp = w.end;
					while (lp < to && masked.charAt(lp) !== "(") lp++;
					var rp = lp < to ? matchClose(masked, lp) : -1;
					if (rp > 0) {
						var bb = skipSpace(rp + 1, to);
						if (masked.slice(bb, bb + 11) === "constructor") bb = skipSpace(bb + 11, to);
						if (masked.charAt(bb) === "{") {
							var be = matchClose(masked, bb);
							if (be > 0) { k = be + 1; continue; }
						}
					}
					k = w.word === "function" ? w.end : w.end;
					continue;
				}
				if (w.word === "return") {
					var rs = skipSpace(w.end, to);
					var re = scanExprEnd(rs);
					if (re > rs) return { s: rs, e: re };
					return null;
				}
				k = w.end;
			}
			return null;
		}

		// Given the position of a function's `(`, return the range of its body braces.
		function fnBody(lp) {
			var rp = matchClose(masked, lp);
			if (rp < 0) return null;
			var b = skipSpace(rp + 1, n);
			if (masked.charAt(b) === ":") return null;                // `function f(): T` - GMEdit owns it
			if (masked.slice(b, b + 11) === "constructor") b = skipSpace(b + 11, n);
			if (masked.charAt(b) !== "{") return null;
			var e = matchClose(masked, b);
			return e < 0 ? null : { b: b, e: e };
		}

		function addFunction(name, lp) {
			var body = fnBody(lp);
			if (body == null) return;
			var r = findFirstReturn(body.b + 1, body.e);
			if (r != null) retRanges.push({ fn: name, s: r.s, e: r.e });
		}

		var m;

		// `function name(args) { ... }` - the declaration form used in scripts.
		var reFn = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
		while ((m = reFn.exec(masked)) !== null) {
			addFunction(m[1], m.index + m[0].length - 1);
		}

		// `name = function (args) { ... }` - how object events (and plenty of older code)
		// actually define functions. GameMaker calls this a method variable, and such a
		// name is *not* global outside its own event, but for completion inside that file
		// it behaves exactly like `function name(...)`, which is what we care about.
		// `options.methods === false` turns this off for the cross-file project index.
		var methodStyle = !(options && options.methods === false);
		var reFnA = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\b/g;
		while ((m = reFnA.exec(masked)) !== null) {
			if (!methodStyle) break;
			var p0 = m.index - 1;
			while (p0 >= 0 && isSpace(masked.charAt(p0))) p0--;
			if (p0 >= 0 && masked.charAt(p0) === ".") continue;       // `obj.fn = function()`
			var k2 = skipSpace(m.index + m[0].length, n);
			if (isIdStart(masked.charAt(k2))) {                        // `x = function named(...)`
				var w3 = readWord(k2, n);
				if (w3 == null) continue;
				k2 = skipSpace(w3.end, n);
			}
			if (masked.charAt(k2) !== "(") continue;
			addFunction(m[1], k2);
		}

		// ---- 2. assignments ---------------------------------------------
		var i = 0;
		while (i < n) {
			var c = masked.charAt(i);
			if (!isIdStart(c)) { i++; continue; }
			if (i > 0 && isIdPart(masked.charAt(i - 1))) { i++; continue; }   // inside a token
			var start = i;
			while (i < n && isIdPart(masked.charAt(i))) i++;
			var word = masked.slice(start, i);
			if (KEYWORDS[word]) continue;
			var j = skipSpace(i, n);
			if (masked.charAt(j) !== "=" || masked.charAt(j + 1) === "=" || masked.charAt(j + 1) === ">") continue;
			var p = start - 1;
			while (p >= 0 && isSpace(masked.charAt(p))) p--;
			var pc = p >= 0 ? masked.charAt(p) : "";
			if (pc === ".") continue;                                         // member assignment: not ours
			var rhsStart = skipSpace(j + 1, n);   // `x =` + newline + `{ ... }` is common GML
			var rhsEnd = scanExprEnd(rhsStart);
			var arow = rowOf(start);
			rawAssigns.push({ name: word, s: rhsStart, e: rhsEnd, row: arow, hint: lineHints[arow] || null });
			// `x = function () { ... }` swallows its whole body as one expression, so jumping
			// to `rhsEnd` would skip every statement inside it. Event code in GMEdit is almost
			// always written that way (`L_release_func = function () { ... }`), so keep
			// scanning from the start of the value instead and let the body be walked normally.
			var vstart = skipSpace(rhsStart, n);
			i = masked.slice(vstart, vstart + 8) === "function" ? vstart : rhsEnd;
		}

		// ---- 2b. `global.NAME = <expr>` ---------------------------------
		// The loop above deliberately skips member assignments (`a.b = ...`), and `global`
		// is a keyword, so these never reached it. They are their own kind of declaration:
		// the name lives in `global.` (project-wide), the value shape is what we want.
		// `global.NAME.field = <expr>` is the second half - code that fills the struct in
		// later (a very common pattern) would otherwise lose those fields.
		var gscan = 0;
		while (gscan < n) {
			var gc = masked.charAt(gscan);
			if (!isIdStart(gc)) { gscan++; continue; }
			if (gscan > 0 && isIdPart(masked.charAt(gscan - 1))) { gscan++; continue; }
			var gw = readWord(gscan, n);
			if (gw == null) { gscan++; continue; }
			gscan = gw.end;
			if (gw.word !== "global") continue;
			var gp = skipSpace(gw.end, n);
			if (masked.charAt(gp) !== ".") continue;
			var g1 = readWord(skipSpace(gp + 1, n), n);
			if (g1 == null) continue;
			var gp2 = skipSpace(g1.end, n);
			if (masked.charAt(gp2) === ".") {                       // global.NAME.field = ...
				var g2 = readWord(skipSpace(gp2 + 1, n), n);
				if (g2 == null) continue;
				var gp3 = skipSpace(g2.end, n);
				if (masked.charAt(gp3) !== "=" ||
					masked.charAt(gp3 + 1) === "=" || masked.charAt(gp3 + 1) === ">") continue;
				globalFieldAdds.push({ base: g1.word, field: g2.word, s: gp3 + 1, e: scanExprEnd(gp3 + 1) });
				gscan = skipSpace(gp3 + 1, n);
				continue;
			}
			if (masked.charAt(gp2) !== "=" || masked.charAt(gp2 + 1) === "=" ||
				masked.charAt(gp2 + 1) === ">") continue;
			// `global.NAME =` followed by a newline and the literal on the next line
			var gs = skipSpace(gp2 + 1, n);
			globalAssigns.push({ name: g1.word, s: gs, e: scanExprEnd(gs) });
			// keep scanning *inside* a function value, exactly like the loop above does
			gscan = masked.slice(gs, gs + 8) === "function" ? gs : scanExprEnd(gs);
		}

		// `localTypes` is a flat, file-wide map, so a name reused in several functions ends
		// up holding the value from the last assignment in the file. For `return x` that is
		// actively wrong (another function's `x` wins), so look at the closest assignment
		// *above* the return instead.
		function typeAtPos(name, pos) {
			var row = rowOf(pos);
			var best = null;
			for (var ti = 0; ti < rawAssigns.length; ti++) {
				var ra = rawAssigns[ti];
				if (ra.name !== name || ra.row > row) continue;
				if (best == null || ra.row >= best.row) best = ra;
			}
			if (best == null) return null;
			return best.hint ? { nm: best.hint, ex: true } : typeOf(best.s, best.e);
		}

		function returnTypeOf(range) {
			var s0 = skipSpace(range.s, range.e);
			var raw = masked.slice(s0, range.e).trim();
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
				var near = typeAtPos(raw, range.s);
				if (near != null) return near;
			}
			return typeOf(range.s, range.e);
		}

		// ---- 3. resolve (a few passes so chains settle) ------------------
		for (var pass = 0; pass < 4; pass++) {
			for (var ri = 0; ri < retRanges.length; ri++) {
				var t = returnTypeOf(retRanges[ri]);
				if (t) returns[retRanges[ri].fn] = t;
			}
			for (var ai = 0; ai < rawAssigns.length; ai++) {
				var a = rawAssigns[ai];
				var tp = a.hint ? { nm: a.hint, ex: true } : typeOf(a.s, a.e);
				if (tp) localTypes[a.name] = tp;
			}
		}

		var vars = [];
		var seen = Object.create(null);
		for (var vi = 0; vi < rawAssigns.length; vi++) {
			var v = rawAssigns[vi];
			var vt = v.hint ? { nm: v.hint, ex: true } : typeOf(v.s, v.e);
			if (!vt) continue;
			var key = v.row + "|" + v.name;
			if (seen[key]) continue;
			seen[key] = true;
			vars.push({ row: v.row, name: v.name, type: vt });
		}

		// `var x; /// @is {T}` - declaration without an initializer.
		var reDecl = /^\s*(?:var|let|const)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][\w<>.,]*)?\s*;/;
		for (var dli = 0; dli < textLines.length; dli++) {
			var dh = lineHints[dli];
			if (dh == null) continue;
			var dm = reDecl.exec(textLines[dli]);
			if (dm == null) continue;
			var dkey = dli + "|" + dm[1];
			if (seen[dkey]) continue;
			seen[dkey] = true;
			vars.push({ row: dli, name: dm[1], type: { nm: dh, ex: true } });
		}

		// ---- 3b. global.NAME types ---------------------------------------
		// Resolved before step 4 so that struct literals on the right-hand side become real
		// entries of `structs` and get their field list filled below.
		var globalsOut = Object.create(null);
		if (GLOB != null) {
			for (var gk in GLOB) {
				if (!Object.prototype.hasOwnProperty.call(GLOB, gk)) continue;
				var gtv = materialize(GLOB[gk], 0);
				if (gtv != null) globalsOut[gk] = gtv;
			}
		}
		for (var gai = 0; gai < globalAssigns.length; gai++) {
			var ga = globalAssigns[gai];
			var gat = typeOf(ga.s, ga.e);
			if (gat != null) globalsOut[ga.name] = gat;      // code in this file wins over the index
		}

		// ---- 4. fill struct field lists (may discover nested structs) ----
		var idx = 0;
		while (idx < structPos.length) {
			if (structs[idx] != null) { idx++; continue; }
			var fields = [];
			var open = structPos[idx];
			var close = matchClose(masked, open);
			if (close > open) {
				var k = open + 1, segStart = k, dP = 0, dB = 0, dC = 0;
				while (k <= close) {
					var ch = masked.charAt(k);
					if (k === close || (ch === "," && dP === 0 && dB === 0 && dC === 0)) {
						addField(segStart, k, fields);
						segStart = k + 1;
					} else if (ch === "(") dP++;
					else if (ch === ")") dP--;
					else if (ch === "[") dB++;
					else if (ch === "]") dB--;
					else if (ch === "{") dC++;
					else if (ch === "}") dC--;
					k++;
				}
			}
			structs[idx] = fields;
			idx++;
		}

		function addField(s0, s1, out) {
			var k = skipSpace(s0, s1);
			if (k >= s1 || !isIdStart(masked.charAt(k))) return;
			var keyStart = k;
			while (k < s1 && isIdPart(masked.charAt(k))) k++;
			var key = masked.slice(keyStart, k);
			var k2 = skipSpace(k, s1);
			if (masked.charAt(k2) !== ":") return;                 // not a key: value pair
			var vs = k2 + 1;
			out.push({ name: key, type: typeOf(vs, s1) });
		}

		// `global.NAME.field = <expr>` - fields filled in after the literal was created.
		// Applied once the literal's own field list exists, and never overwriting a field
		// that the literal already declares.
		for (var gfi = 0; gfi < globalFieldAdds.length; gfi++) {
			var gfa = globalFieldAdds[gfi];
			var gbase = globalsOut[gfa.base];
			if (gbase == null || gbase.st == null) continue;
			var gflist = structs[gbase.st - 1];
			if (gflist == null) continue;
			var gdup = false;
			for (var gfj = 0; gfj < gflist.length; gfj++) {
				if (gflist[gfj].name === gfa.field) { gdup = true; break; }
			}
			if (gdup) continue;
			gflist.push({ name: gfa.field, type: typeOf(gfa.s, gfa.e) });
		}

		// trim trailing nulls that appear when a struct never got resolved
		var structOut = [];
		for (var si = 0; si < structPos.length; si++) structOut.push(structs[si] || []);

		return { structs: structOut, vars: vars, returns: returns, globals: globalsOut };
	}

	// Collect every *definition site* in one file, for the middle-click "go to definition"
	// feature. Positions are 0-based and relative to the file that was scanned, which is what
	// the editor needs when it opens a script; object events get re-based later on.
	function defs(text) {
		var masked = mask(text);
		var n = masked.length;
		var lineStarts = [0];
		for (var li = 0; li < n; li++) if (text.charCodeAt(li) === 10) lineStarts.push(li + 1);
		function rowOf(pos) {
			var lo = 0, hi = lineStarts.length - 1;
			while (lo < hi) {
				var mid = (lo + hi + 1) >> 1;
				if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
			}
			return lo;
		}
		var out = [];
		var seen = Object.create(null);
		function skipFrom(from) {
			var k = from;
			while (k < n && isSpace(masked.charAt(k))) k++;
			return k;
		}
		function push(name, pos, kind) {
			if (name == null || name === "") return;
			var row = rowOf(pos);
			var key = row + "|" + name;
			if (seen[key]) return;
			seen[key] = true;
			out.push({
				name: name,
				row: row,
				col: pos - lineStarts[row],
				kind: kind
			});
		}
		var m;
		var reFn = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
		while ((m = reFn.exec(masked)) !== null) {
			push(m[1], m.index + m[0].indexOf(m[1]), "function");
		}
		var reFnA = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\b/g;
		while ((m = reFnA.exec(masked)) !== null) {
			var p0 = m.index - 1;
			while (p0 >= 0 && isSpace(masked.charAt(p0))) p0--;
			if (p0 >= 0 && masked.charAt(p0) === ".") continue;
			push(m[1], m.index, "method");
		}
		var reMacro = /#macro\s+([A-Za-z_][A-Za-z0-9_]*)/g;
		while ((m = reMacro.exec(masked)) !== null) {
			push(m[1], m.index + m[0].lastIndexOf(m[1]), "macro");
		}
		var reEnum = /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/g;
		while ((m = reEnum.exec(masked)) !== null) {
			push(m[1], m.index + m[0].lastIndexOf(m[1]), "enum");
		}
		// `global.NAME = ...` - the place a global is actually created. Only assignments
		// count: registering every *use* would flood the index with uses that outrank the
		// real definition (a name is kept up to MAX_DEFS times).
		var reGlobDef = /\bglobal\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?![=>])/g;
		while ((m = reGlobDef.exec(masked)) !== null) {
			push(m[1], m.index + m[0].lastIndexOf(m[1]), "global");
		}
		// Plain assignments: `var x = ...`, `hp = 100`, struct fields excluded by the `.` check.
		var i = 0;
		while (i < n) {
			var c = masked.charAt(i);
			if (!isIdStart(c)) { i++; continue; }
			if (i > 0 && isIdPart(masked.charAt(i - 1))) { i++; continue; }
			var start = i;
			while (i < n && isIdPart(masked.charAt(i))) i++;
			var word = masked.slice(start, i);
			var j = skipFrom(i);
			if (masked.charAt(j) !== "=" || masked.charAt(j + 1) === "=" || masked.charAt(j + 1) === ">") continue;
			var p1 = start - 1;
			while (p1 >= 0 && isSpace(masked.charAt(p1))) p1--;
			if (p1 >= 0 && masked.charAt(p1) === ".") continue;
			push(word, start, "variable");
		}
		return out;
	}

	return { analyze: analyze, defs: defs, mask: mask };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TypeMasterAnalyzer;
