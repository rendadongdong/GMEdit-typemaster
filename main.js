// gm-typemaster / main.js
// Wires TypeMasterAnalyzer into GMEdit: inferred types are injected into the editor's own
// type tables, so the native completion popup lists struct fields without any annotations.
(function () {
	"use strict";

	var NS_PREFIX = "$tm.";
	var REBUILD_MS = 400;

	var CACHE = null;
	var FALLBACK_LOGGED = false;
	var GEN = 0;
	var enabled = true;
	var FIRST_INJECT = false;

	// `smartCompleter` (import table) and `smartAltCompleter` (global table) both run for the
	// same `.` request, and Ace concatenates their results without de-duplicating. Now that
	// synthesized namespaces are mirrored into both tables, we have to remember whether the
	// primary completer already answered, so the alt one can stay quiet.
	var LAST_PRIMARY = { pos: null, row: -1, time: 0, count: 0 };
	var PRIMARY_WINDOW_MS = 200;
	var ALT_SUPPRESS_LOGGED = false;

	function primaryAnswered(pos) {
		if (LAST_PRIMARY.count <= 0) return false;
		// Ace hands the very same `pos` object to every completer of one request, so an
		// identity match is conclusive. The short time window is only a fallback for the
		// case where an adapter clones `pos` on the way through.
		if (LAST_PRIMARY.pos === pos) return true;
		return LAST_PRIMARY.row === pos.row &&
			(Date.now() - LAST_PRIMARY.time) < PRIMARY_WINDOW_MS;
	}

	function notePrimary(pos, count) {
		LAST_PRIMARY = { pos: pos, row: pos.row, time: Date.now(), count: count };
	}

	function G(name) { return window.$gmedit[name]; }
	function log() {
		try {
			var args = Array.prototype.slice.call(arguments);
			args.unshift("[typemaster]");
			console.log.apply(console, args);
		} catch (e) { /* ignore */ }
	}

	function typeNameOf(t) {
		if (!t) return null;
		if (t.st != null) return NS_PREFIX + t.st;
		if (t.obj != null) return t.obj;
		if (t.nm) return t.nm;
		return null;
	}

	function shortType(tn) {
		if (!tn) return "field";
		if (tn.indexOf(NS_PREFIX) === 0) return "struct";
		return tn;
	}

	// Object namespaces are normally built by GMEdit while indexing the project. If a file
	// references an object that has not been indexed yet, create a placeholder so that at
	// least the built-in instance variables (x, y, depth, sprite_index, ...) are offered.
	function ensureObjectNs(name) {
		try {
			var A = G("gml.GmlAPI");
			var ns = A.gmlNamespaces[name];
			if (ns != null) return ns;
			ns = new (G("gml.GmlNamespace"))(name);
			ns.isObject = true;
			A.gmlNamespaces[name] = ns;
			try {
				A.gmlNamespaceComp.set(name, { name: name, value: name, score: 0, meta: "object", doc: null });
			} catch (e) { /* ignore */ }
			try { A.gmlKind[name] = "asset.object"; } catch (e) { /* ignore */ }
			log("placeholder object namespace created:", name);
			return ns;
		} catch (e) {
			log("could not ensure object namespace:", name, e);
			return null;
		}
	}

	function ensureForType(t) {
		if (!t) return;
		if (t.obj) { ensureObjectNs(t.obj); return; }
		if (t.ex && t.nm) ensureIfObjectName(t.nm);
	}

	// A hand-written `/// @is {obj_foo}` may name an object that has not been indexed yet.
	function ensureIfObjectName(name) {
		try {
			if (collectObjectNames().indexOf(name) >= 0) ensureObjectNs(name);
		} catch (e) { /* ignore */ }
	}

	function isOwnType(typeObj) {
		try {
			var ns = G("gml.type.GmlTypeTools").getNamespace(typeObj);
			return typeof ns === "string" && ns.indexOf(NS_PREFIX) === 0;
		} catch (e) { return false; }
	}

	// `object` / `instance` / `struct` are what GMEdit infers when it only knows
	// "some instance" or "some struct". A concrete namespace is strictly more useful.
	var GENERIC_TYPES = { object: 1, instance: 1, struct: 1, any: 1, value: 1, variable: 1 };
	function isGenericInstanceType(typeObj) {
		try {
			var ns = G("gml.type.GmlTypeTools").getNamespace(typeObj);
			return ns != null && GENERIC_TYPES[ns] === 1;
		} catch (e) { return false; }
	}

	var OBJECTS = null;
	var OBJECTS_TIME = 0;

	function collectObjectNames() {
		var now = Date.now();
		if (OBJECTS && now - OBJECTS_TIME < 5000) return OBJECTS;
		var out = [];
		try {
			var P = G("gml.Project");
			var rt = P && P.current ? P.current.resourceTypes : null;
			if (rt) {
				for (var k in rt) {
					if (Object.prototype.hasOwnProperty.call(rt, k) && rt[k] === "object") out.push(k);
				}
			}
		} catch (e) { /* ignore */ }
		try {
			var ns = G("gml.GmlAPI").gmlNamespaces;
			if (ns) {
				for (var n2 in ns) {
					var item = ns[n2];
					if (item && item.isObject && out.indexOf(n2) < 0) out.push(n2);
				}
			}
		} catch (e) { /* ignore */ }
		OBJECTS = out;
		OBJECTS_TIME = now;
		return out;
	}

	// ---- project-wide function return types ---------------------------------
	// Function bodies usually live in script assets while the calls sit in object events,
	// so analysing only the open file misses every factory function. This index walks the
	// project's `scripts/` and `objects/` folders once and records, for each function, the
	// shape of its first `return` (already expanded into a portable tree).

	var EXTERNAL = Object.create(null);   // fn -> { struct: [...] } | { obj } | { nm }
	// `global.NAME = ...` shapes, same tree format. GMEdit lists globals after `global.`
	// but has no idea what they hold, so `global.CONFIG.` was always empty.
	var GLOBALS = Object.create(null);
	// fn -> the `///@desc` (or loose `///`) text written above its definition. GMEdit
	// ignores `@desc` completely and prints only `name(args)` in the tooltip and the
	// status bar, so the text has to be carried separately and glued on there.
	var DOCS = Object.create(null);
	// `struct path -> {d: sentence, t: type name}` for `///@is` written on a struct field.
	// `null` means "two different sentences for this name" - see `mergeFields`.
	var FIELDS = Object.create(null);
	var INDEX_READY = false;
	var INDEX_TIME = 0;
	var INDEX_TRY = 0;
	var INDEX_BUILDING = false;

	// ---- definition index (middle-click "go to definition") ------------------
	// name -> [{ path, sub, obj, file, row, col, kind }]
	// `sub` is the event name inside an object: GMEdit edits a whole object as one buffer
	// (`#event create` sections), so object-event definitions are addressed by
	// `.yy path + event name`, not by the event .gml file.
	var DEFS = Object.create(null);
	var DEFS_COUNT = 0;
	var MAX_DEFS = 6;
	var EVENT_RETRY = 0;

	var EVENT_MAP = null;
	function eventNameMap() {
		if (EVENT_MAP != null) return EVENT_MAP;
		var out = Object.create(null);
		try {
			var E = G("parsers.GmlEvent"), YE = G("yy.YyEvent");
			if (E != null && YE != null) {
				for (var t in E.i2s) {
					if (t === "4" || t === "11") continue;          // collision / trigger: id-based names
					var arr = E.i2s[t];
					if (arr == null) continue;
					for (var num = 0; num < arr.length; num++) {
						if (arr[num] == null) continue;
						var fn = null;
						try { fn = YE.toPath(+t, num, null); } catch (e) { fn = null; }
						// keyed without the extension: `Create_0.gml` -> "create_0"
						if (fn) out[String(fn).replace(/\.gml$/i, "").toLowerCase()] = arr[num];
					}
				}
			}
		} catch (e) { log("event name map failed:", e); }
		// `parsers.GmlEvent.i2s` is filled from api/events.gml asynchronously; do not cache an
		// empty table, or every object-event definition would stay unreachable.
		if (Object.keys(out).length > 0) EVENT_MAP = out;
		return out;
	}

	// `.../objects/obj_x/Create_0.gml` -> { path: ".../objects/obj_x/obj_x.yy", sub: "create" }
	function eventInfoFor(file) {
		var m = /[\\/]objects[\\/]([^\\/]+)[\\/]([^\\/]+)\.gml$/i.exec(file);
		if (m == null) return null;
		var sub = eventNameMap()[m[2].toLowerCase()];
		if (sub == null) return null;
		var dir = file.replace(/[\\/][^\\/]+$/, "");
		var sep = file.charAt(dir.length) || "/";
		return { path: dir + sep + m[1] + ".yy", sub: sub, obj: m[1] };
	}

	function addDef(name, info, d) {
		var arr = DEFS[name];
		if (arr == null) arr = DEFS[name] = [];
		if (arr.length >= MAX_DEFS) return;
		arr.push({
			name: name,
			path: info ? info.path : d.file,
			sub: info ? info.sub : null,
			obj: info ? info.obj : null,
			file: d.file,
			row: d.row,
			col: d.col,
			kind: d.kind
		});
		DEFS_COUNT++;
	}

	function projectRoot() {
		try {
			var P = G("gml.Project");
			return P && P.current ? (P.current.dir || null) : null;
		} catch (e) { return null; }
	}

	// Turn a file-local type (struct ids belong to that file) into a tree without ids.
	function shapeType(t, structs, depth) {
		if (t == null || depth > 8) return null;
		if (t.st != null) {
			var fields = structs[t.st - 1];
			if (fields == null) return null;
			var arr = [];
			for (var i = 0; i < fields.length; i++) {
				arr.push({ name: fields[i].name, type: shapeType(fields[i].type, structs, depth + 1) });
			}
			return { struct: arr };
		}
		if (t.obj != null) return { obj: t.obj };
		if (t.nm) return { nm: t.nm, ex: t.ex === true };
		return null;
	}

	function buildProjectIndex() {
		if (INDEX_BUILDING) return;
		var root = projectRoot();
		if (root == null) return;
		var fs, path;
		try {
			fs = require("fs");
			path = require("path");
		} catch (e) {
			log("fs is not available, cross-file index skipped");
			return;
		}
		INDEX_BUILDING = true;
		var started = Date.now();
		var files = [];
		var out = Object.create(null);
		var gout = Object.create(null);
		var dout = Object.create(null);
		var fout = Object.create(null);

		function walk(dir, depth) {
			if (depth > 6) return;
			var ents;
			try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
			for (var i = 0; i < ents.length; i++) {
				var ent = ents[i];
				if (ent.isDirectory()) {
					if (ent.name === "tmp") continue;
					walk(path.join(dir, ent.name), depth + 1);
				} else if (/\.gml$/i.test(ent.name)) {
					files.push(path.join(dir, ent.name));
				}
			}
		}

		try {
			var dirs = [path.join(root, "scripts"), path.join(root, "objects")];
			for (var d = 0; d < dirs.length; d++) walk(dirs[d], 0);
			var defsOut = Object.create(null);
			DEFS = defsOut;
			DEFS_COUNT = 0;
			var eventMapPending = false;
			for (var f = 0; f < files.length; f++) {
				var src;
				try { src = fs.readFileSync(files[f], "utf8"); } catch (e) { continue; }
				var data;
				// `name = function () {...}` inside an object event is an instance method, not a
				// global function, so only script files contribute those to the cross-file index.
				var methodsOk = /[\\/]scripts[\\/]/i.test(files[f]);
				try { data = TypeMasterAnalyzer.analyze(src, { objects: [], methods: methodsOk }); } catch (e) { continue; }
				for (var fn in data.returns) {
					if (out[fn] != null) continue;          // first definition wins
					var tree = shapeType(data.returns[fn], data.structs, 0);
					if (tree != null) out[fn] = tree;
				}
				// `global.NAME = ...` lives in exactly one file too (usually a script that
				// builds the game's data), while `global.NAME.` is used everywhere.
				var gsrc = data.globals || {};
				for (var gn in gsrc) {
					// First definition wins, except that a struct shape always beats a
					// guess like `array` / `undefined` from an unrelated re-assignment.
					if (gout[gn] != null && (gout[gn].struct != null || gsrc[gn].st == null)) continue;
					var gtree = shapeType(gsrc[gn], data.structs, 0);
					if (gtree != null) gout[gn] = gtree;
				}
				// `///@desc` texts, same first-definition-wins rule.
				var dsrc = data.docs || {};
				for (var dn in dsrc) {
					if (dsrc[dn] != null && dout[dn] == null) dout[dn] = dsrc[dn];
				}
				// `///@is` sentences on struct fields. A field name is not unique across
				// structs, so `mergeFields` refuses to pick between conflicting sentences.
				var fsrc = data.fields || {};
				for (var fk in fsrc) {
					if (fsrc[fk] === undefined) continue;
					if (fout[fk] === undefined) fout[fk] = fsrc[fk];      // first file wins
					// A file that already saw two different sentences for this name knows it
					// cannot be resolved; letting another file's sentence stand would show a
					// caption that is wrong half the time.
					else if (fout[fk] !== null && fsrc[fk] === null) fout[fk] = null;
				}
				// Second pass: where is each symbol actually defined (for middle-click jump).
				// `eventNameMap()` is filled asynchronously from api/events.gml. While it is still
				// empty an object event has no `.yy` counterpart, so defer instead of indexing it
				// as a plain file - otherwise every method in `objects/` silently disappears from
				// the index and middle click falls back to "open the manual".
				var info = eventInfoFor(files[f]);
				if (info == null && /[\\/]objects[\\/]/i.test(files[f]) &&
					Object.keys(eventNameMap()).length === 0) {
					eventMapPending = true;
					continue;
				}
				var list;
				try { list = TypeMasterAnalyzer.defs(src); } catch (e) { list = null; }
				if (list == null) continue;
				for (var di = 0; di < list.length; di++) {
					var d1 = list[di];
					d1.file = files[f];
					addDef(d1.name, info, d1);
				}
			}
			DEFS = defsOut;
			EXTERNAL = out;
			GLOBALS = gout;
			DOCS = dout;
			FIELDS = fout;
			INDEX_READY = true;
			INDEX_TIME = Date.now();
			CACHE = null;
			log("project index: " + files.length + " file(s), " +
				Object.keys(out).length + " function(s) with a return type, " +
				Object.keys(gout).length + " global(s) with a known shape, " +
				Object.keys(dout).length + " documented function(s), " +
				Object.keys(fout).length + " documented field/member caption(s), " +
				Object.keys(DEFS).length + " symbol(s) with a location, " +
				(INDEX_TIME - started) + "ms");
			if (eventMapPending && EVENT_RETRY < 8) {
				EVENT_RETRY++;
				window.setTimeout(function () {
					try { buildProjectIndex(); } catch (e) { log("index retry failed:", e); }
				}, 1200);
			}
		} catch (e) {
			log("project index failed:", e);
		} finally {
			INDEX_BUILDING = false;
		}
	}

	// Build lazily: a project may be opened after the plugin finished loading.
	function ensureProjectIndex() {
		if (INDEX_READY || INDEX_BUILDING || !enabled) return;
		var now = Date.now();
		if (now - INDEX_TRY < 3000) return;
		INDEX_TRY = now;
		window.setTimeout(function () {
			if (INDEX_READY) return;          // a middle click may have built it already
			try { buildProjectIndex(); } catch (e) { log("index failed:", e); }
		}, 30);
	}

	// ---- `///@desc`: put the description where the signature is printed -----------
	// GMEdit parses `@param` / `@returns` / `@hint`, but `@desc` has no handler at all:
	// `jsDoc_anyTag` matches the line and it falls through to the "append to the
	// completion doc" branch, so it never reaches the two places a signature is shown -
	// the hover tooltip (`ace.AceTooltips` -> `GmlFuncDoc.getAcText`) and the status bar
	// (`ace.AceStatusBar.updateComp`, which prints `pre + args + post` by hand).
	// The analyzer picks the text up (see `docTextAbove` there); these are the two
	// append points. Both maps are keyed by the bare function name.

	function mergeDocs(map) {
		if (map == null) return;
		for (var k in map) {
			if (map[k] != null && map[k] !== DOCS[k]) DOCS[k] = map[k];
		}
	}

	function descOf(name) {
		if (name == null) return null;
		var s = String(name).trim();
		if (s === "") return null;
		if (DOCS[s] != null) return DOCS[s];
		// `obj.method` / `ns::fn` - the doc belongs to the bare name
		var cut = s.lastIndexOf("::");
		if (cut >= 0) s = s.slice(cut + 2);
		else if ((cut = s.lastIndexOf(".")) >= 0) s = s.slice(cut + 1);
		else return null;
		return DOCS[s] != null ? DOCS[s] : null;
	}

	var FUNCDOC_HOOKED = false;
	function hookFuncDoc() {
		if (FUNCDOC_HOOKED) return;
		var FD = G("gml.GmlFuncDoc");
		if (FD == null || FD.prototype == null) return;
		FUNCDOC_HOOKED = true;
		var orig = FD.prototype.getAcText;
		FD.prototype.getAcText = function () {
			var s = orig.apply(this, arguments);
			try {
				var d = descOf(this.name);
				// Guard against a doc whose own text already carries the sentence: the
				// completion path stores `getAcText()` output, which would stack up.
				if (d != null && s.indexOf(d) < 0) return s + "\n" + d;
			} catch (e) { /* ignore */ }
			return s;
		};
		log("function docs: ///@desc is appended to the signature");
	}

	var SBAR_HOOKED = false;
	function hookStatusBar() {
		if (SBAR_HOOKED) return;
		var SB = G("ace.AceStatusBar");
		if (SB == null || SB.prototype == null) return;
		SBAR_HOOKED = true;
		var orig = SB.prototype.updateComp;
		SB.prototype.updateComp = function () {
			var r = orig.apply(this, arguments);
			try { appendHintDesc(this); } catch (e) { /* ignore */ }
			return r;
		};
		log("status bar: ///@desc follows the argument hint");
	}

	// The status bar rebuilds `statusHint.innerHTML` from scratch on every caret move, so
	// appending here never duplicates. `firstChild == null` means the original already
	// bailed out (no signature for this position) - the element it emptied must stay
	// empty, otherwise a lone "— description" would sit in the bar with no function name.
	function appendHintDesc(bar) {
		var hint = bar != null ? bar.statusHint : null;
		if (hint == null || hint.firstChild == null) return;
		var txt = hint.textContent || "";
		var i = txt.indexOf("(");
		if (i <= 0) return;
		var d = descOf(txt.slice(0, i).trim());
		if (d == null) return;
		var span = document.createElement("span");
		span.className = "tm-hint-desc";
		span.appendChild(document.createTextNode(" — " + d));
		hint.appendChild(span);
		hint.title = txt + "\n" + d;
	}

	// ---- `///@is {T} 说明`: the sentence attached to one variable ------------------
	// `///@desc` describes a *function* and rides on `GmlFuncDoc`. A variable has no such
	// object - the tooltip for a local is produced by the `local`/`sublocal` resolver in
	// `ace.AceStatusBar.canDocData`, which only knows the type (`ctx.type`) and hands it
	// to `ace.AceTooltips.getDocAt_extra` as `"type <name>"`. There is no slot for prose,
	// so the text is collected by the analyzer (`vars[].desc`) and appended to the
	// tooltip afterwards.
	//
	// Keyed by session (the analyzer caches per session) with a fallback to the owning
	// editor's session: the aside pane works on a *clone* of the left session, and the
	// clone is exactly the owner's `session` in the same `gmlEditor`.
	var VAR_DOCS = (typeof WeakMap === "function") ? new WeakMap() : null;
	var VARDOC_HOOKED = false;

	function varDocTable(session, gen) {
		if (VAR_DOCS == null || session == null) return null;
		var t;
		try { t = VAR_DOCS.get(session); } catch (e) { return null; }
		if (t == null || (gen != null && t.gen !== gen)) {
			t = { gen: gen, map: Object.create(null) };
			try { VAR_DOCS.set(session, t); } catch (e) { return null; }
		}
		return t.map;
	}

	// Called from `applyToInner`, once per analysed variable that carries a `@is` sentence.
	// `gen` is the analysis generation: a re-parse throws the old table away, so a deleted
	// annotation cannot linger.
	//
	// `typeName` is the printable type (`number`, `obj_item_parent`, `struct`) or null. It
	// is what the tooltip has to fall back on when GMEdit shows nothing of its own - a
	// constructor member is a `field` token, and those never get a `ctx.type`.
	function rememberVarDesc(session, gen, scope, name, desc, typeName) {
		if (desc == null || name == null || scope == null) return;
		var map = varDocTable(session, gen);
		if (map == null) return;
		var bucket = map[scope];
		if (bucket == null) bucket = map[scope] = Object.create(null);
		bucket[name] = { d: desc, t: typeName != null ? typeName : null };
	}

	// Struct fields have no session/scope to key on - the same `DATA_STRUCT.X` is reachable
	// from every file - so they live in one project-wide table keyed by the path that names
	// them (`DATA_STRUCT.PLACE_FROM_STORAGE`) plus the bare field name.
	// A `null` entry means "the same name carries two different sentences"; that is sticky
	// for the project index, because guessing between two sentences is worse than showing
	// none. `live` (the file being edited) overwrites unconditionally - a reworded
	// annotation has to win over whatever the index saw at startup.
	function mergeFields(map, live) {
		if (map == null) return;
		for (var k in map) {
			var v = map[k];
			if (v === undefined) continue;
			if (!live && FIELDS[k] === null) continue;
			FIELDS[k] = v;
		}
	}

	var RESERVED_BEFORE = /[A-Za-z0-9_.]/;

	// `global.DATA_STRUCT.PLACE_FROM_STORAGE` -> "global.DATA_STRUCT" (no trailing dot).
	// `token.value` may be the field or the whole dotted path depending on how the mode
	// tokenizes it, so the start of the token is located by searching backwards from the
	// caret; everything identifier-ish before it is the qualifier.
	function exprPathBefore(session, pos, token) {
		var line = null;
		try { line = session.getLine(pos.row); } catch (e) { return null; }
		if (line == null) return null;
		var name = token != null && typeof token.value === "string" ? token.value : "";
		var at = -1;
		if (name !== "") {
			var from = Math.min(pos.column != null ? pos.column : 0, line.length);
			at = line.lastIndexOf(name, from);
		}
		if (at < 0) at = Math.min(pos.column != null ? pos.column : 0, line.length);
		// No dot right before the name (`x = NAME`, `f(NAME)`) means there is no qualifier
		// at all - scanning back from there would happily return `x =` as a "path".
		var before = at - 1;
		while (before >= 0 && (line.charAt(before) === " " || line.charAt(before) === "\t")) before--;
		if (before < 0 || line.charAt(before) !== ".") return null;
		var i = before;
		while (i > 0 && RESERVED_BEFORE.test(line.charAt(i - 1))) i--;
		var pre = line.slice(i, before).trim();
		return pre === "" ? null : pre;
	}

	function fieldInfoOf(session, pos, token) {
		var name = token != null && typeof token.value === "string" ? token.value : null;
		if (name == null || name === "") return null;
		var raw = String(name).replace(/^global\s*\.\s*/, "");
		// A token that already spells out the path (`global.DATA.X` as one token) is the
		// most specific answer there is.
		if (raw.indexOf(".") >= 0) {
			var whole = FIELDS[raw];
			if (whole != null) return whole;
		}
		if (pos != null) {
			var path = exprPathBefore(session, pos, token);
			if (path != null) {
				var p = path.replace(/^global\s*\.\s*/, "");
				var hit = FIELDS[p + "." + name];
				if (hit != null) return hit;
				// `_cfg.A.B` / `room.data.X`: drop leading qualifiers one at a time, the
				// table only holds paths that start at a name the analyzer knows.
				var dot;
				while ((dot = p.indexOf(".")) >= 0) {
					p = p.slice(dot + 1);
					hit = FIELDS[p + "." + name];
					if (hit != null) return hit;
				}
				// Bare name last, and only for an actual `expr.NAME` access: it exists so
				// that a local alias (`_x = global.DATA; _x.Y`) still answers. Handing it
				// out for a plain identifier would caption unrelated locals that happen to
				// share a name with some struct field.
				var bare = FIELDS[raw];
				return bare != null ? bare : null;
			}
		}
		return null;
	}

	function varDescOf(session, name, row) {
		if (session == null || name == null) return null;
		var t = null;
		if (VAR_DOCS != null) {
			try { t = VAR_DOCS.get(session); } catch (e) { t = null; }
			// The aside pane's session is a clone; the injection that filled the table ran
			// on the original one.
			if (t == null) {
				try {
					var owner = session.gmlEditor != null ? session.gmlEditor.session : null;
					if (owner != null && owner !== session) t = VAR_DOCS.get(owner);
				} catch (e) { t = null; }
			}
		}
		if (t == null) return null;
		var scope = null;
		try { scope = session.gmlScopes ? session.gmlScopes.get(row) : null; } catch (e) { scope = null; }
		if (scope != null) {
			var bucket = t.map[scope];
			if (bucket != null && bucket[name] != null) return bucket[name];
		}
		// No scope, or the name is not in it: accept a match from anywhere in the file only
		// when every candidate says the same thing - guessing between two different
		// sentences would show the wrong one.
		var found = null;
		for (var k in t.map) {
			var b = t.map[k];
			if (b == null || b[name] == null) continue;
			if (found != null && found.d !== b[name].d) return null;
			found = b[name];
		}
		return found;
	}

	function hookTooltips() {
		if (VARDOC_HOOKED) return;
		var TT = G("ace.AceTooltips");
		if (TT == null || TT.prototype == null) return;
		VARDOC_HOOKED = true;
		var orig = TT.prototype.update;
		TT.prototype.update = function (session, pos, token) {
			var r = orig.apply(this, arguments);
			try { appendVarDesc(this, session, pos, token); } catch (e) { /* ignore */ }
			return r;
		};
		log("tooltips: ///@is descriptions are appended");
	}

	// Runs after the original `update`. At that point `this.text` holds exactly what is on
	// screen (`"type obj_item_parent"`, or `null` when the variable has no known type), and
	// `this.ttip` has already been told about it - so a later `setText` here wins.
	// Same-token repeat calls do not exist (`updateKeyboard`/`sync` compare against
	// `this.token` first), but the `indexOf` guard keeps it idempotent anyway.
	//
	// Two sources, in order: a `@is` sentence on a local variable / constructor member
	// (keyed by session+scope), then a `@is` sentence on a struct field (keyed by path in
	// the project-wide table). Both also supply a type line, because GMEdit prints
	// *nothing* for a `field` / `localfield` token - it only sets `ctx.docs`, never
	// `ctx.type` - and that is exactly what a struct field and a constructor member are.
	function appendVarDesc(tt, session, pos, token) {
		if (tt == null) return;
		var name = token != null ? token.value : null;
		if (typeof name !== "string" || name === "") return;
		// A sprite tooltip is a thumbnail drawn with `setHtml`; rewriting `text` would
		// replace the picture with a plain line, so that case is left alone.
		if (token.type === "asset.sprite") return;
		var row = pos != null && pos.row != null ? pos.row : 0;
		var d = null;
		var head = null;
		var vd = varDescOf(session, name, row);
		if (vd != null) {
			d = vd.d;
			if (vd.t != null) head = "type " + vd.t;
		} else {
			var info = fieldInfoOf(session, pos, token);
			if (info == null) return;
			d = info.d;
			if (info.t != null) head = "type " + info.t;
		}
		if (d == null) return;
		var cur = tt.text;
		if (cur == null) {
			// Nothing to prefix it with (an untyped local, or a struct field): the sentence
			// - plus the type we know about - is still worth showing on its own.
			tt.text = head != null ? head + "\n" + d : d;
		} else {
			if (cur.indexOf(d) >= 0) return;
			tt.text = cur + "\n" + d;
		}
		try { if (tt.ttip != null) tt.ttip.setText(tt.text); } catch (e) { /* ignore */ }
	}

	// Same, but blocking - used by the middle-click resolver, where the answer is needed
	// *now* and "wait for the next completion" would mean another trip to the manual.
	var INDEX_SYNC_AT = 0;
	function ensureIndexNow() {
		if (INDEX_READY || INDEX_BUILDING || !enabled) return INDEX_READY;
		var now = Date.now();
		if (now - INDEX_SYNC_AT < 2000) return false;    // do not stall every click
		INDEX_SYNC_AT = now;
		try { buildProjectIndex(); } catch (e) { log("synchronous index build failed:", e); }
		return INDEX_READY;
	}

	// Replace the synthetic namespace so that stale fields never linger.
	function freshNamespace(name) {
		var A = G("gml.GmlAPI");
		var ns = new (G("gml.GmlNamespace"))(name);
		ns.noTypeRef = true;
		ns.avoidHighlight = true;
		ns.canCastToStruct = true;
		A.gmlNamespaces[name] = ns;
		return ns;
	}

	function copyFields(src, dst) {
		if (src == null || dst == null) return;
		var arr = src.compInst ? src.compInst.array : null;
		if (arr == null) return;
		var types = src.instTypes || {};
		for (var i = 0; i < arr.length; i++) {
			var item = arr[i];
			if (item == null || item.name == null || item.name === "") continue;
			try {
				dst.addFieldHint(item.name, true, item, null, types[item.name] || null);
			} catch (e) { /* ignore */ }
		}
	}

	// GMEdit's dot completion (dotKind = 5) resolves a type to a namespace through
	// `imports[scope].namespaces[typeName]`, not through the global `gmlNamespaces` table
	// (only the alt/new completer has dotKindMeta set, and looks at globals).
	// So every synthetic/placeholder namespace also has to exist per import.
	function mirrorToImport(imp, tn, t) {
		if (imp == null || imp.namespaces == null || tn == null) return null;
		var isStruct = tn.indexOf(NS_PREFIX) === 0;
		var isObject = t != null && t.obj != null;
		if (!isStruct && !isObject) return null;
		var src;
		try { src = G("gml.GmlAPI").gmlNamespaces[tn]; } catch (e) { return null; }
		if (src == null) return null;
		var dst = null;
		try {
			dst = imp.namespaces[tn];
			// Struct namespaces are rebuilt on every analysis pass, so refresh the copy as well.
			if (dst == null || isStruct) {
				var NsC = G("gml.GmlImportNamespace") || G("gml.GmlNamespace");
				dst = new NsC(tn);
				dst.noTypeRef = true;
				dst.avoidHighlight = true;
				dst.canCastToStruct = true;
				if (isObject) dst.isObject = true;
				imp.namespaces[tn] = dst;
			}
			copyFields(src, dst);
		} catch (e) {
			log("could not mirror namespace:", tn, e);
			return null;
		}
		return dst;
	}

	// `global.NAME` types. GMEdit's linter resolves a global field through
	// `GmlAPI.gmlGlobalTypes[NAME]` (namespace `global` is type kind 8), so writing a
	// namespace name there is enough to make `global.NAME.` complete - and to make
	// `global.NAME.field.` chain resolve as well, because struct namespaces are mirrored
	// into the current import (see mirrorStructs).
	// Values the user has annotated themselves (`/// @is`) are left alone.
	function applyGlobals(data) {
		if (!data || !data.globals) return 0;
		var A, TDef;
		try {
			A = G("gml.GmlAPI");
			TDef = G("gml.type.GmlTypeDef");
		} catch (e) { return 0; }
		if (A == null || A.gmlGlobalTypes == null || TDef == null) return 0;
		var n = 0;
		for (var name in data.globals) {
			if (!Object.prototype.hasOwnProperty.call(data.globals, name)) continue;
			var t = data.globals[name];
			var tn = typeNameOf(t);
			if (!tn) continue;
			ensureForType(t);
			var cur = A.gmlGlobalTypes[name];
			if (cur != null && !isOwnType(cur) && !isGenericInstanceType(cur)) continue;
			try {
				A.gmlGlobalTypes[name] = TDef.simple(tn);
				n++;
			} catch (e) { /* ignore */ }
		}
		return n;
	}

	function registerStructs(data) {
		var TDef = G("gml.type.GmlTypeDef");
		for (var i = 0; i < data.structs.length; i++) {
			var fields = data.structs[i];
			var ns = freshNamespace(NS_PREFIX + (i + 1));
			for (var f = 0; f < fields.length; f++) {
				var field = fields[f];
				ensureForType(field.type);
				var tn = typeNameOf(field.type);
				var ty = null;
				try { ty = tn ? TDef.simple(tn) : null; } catch (e) { ty = null; }
				ns.addFieldHint(field.name, true, {
					name: field.name,
					value: field.name,
					score: 0,
					meta: shortType(tn),
					doc: null
				}, null, ty);
			}
		}
	}

	// Two panes share one document but must not share one cache slot: with a single slot the
	// left pane invalidates the right pane on every keystroke, so both re-parse the same text
	// alternately - on a big object file that is what makes the aside pane feel frozen.
	var CACHE_MAP = (typeof WeakMap === "function") ? new WeakMap() : null;

	function quickSig(text) {
		var n = text.length;
		if (n === 0) return "0";
		var mid = n >> 1;
		return n + "|" + text.slice(0, 8) + "|" + text.charCodeAt(mid) + "|" + text.slice(-8);
	}

	function getData(session) {
		var now = Date.now();
		var text = null;
		try { text = session.getValue(); } catch (e) { text = null; }
		var sig = text == null ? null : quickSig(text);
		var hit = CACHE_MAP != null
			? CACHE_MAP.get(session)
			: (CACHE && CACHE.session === session ? CACHE : null);
		if (hit != null && (sig != null ? hit.sig === sig : now - hit.time < REBUILD_MS)) {
			CACHE = hit;
			return hit.data;
		}
		var data;
		ensureProjectIndex();
		try {
			data = TypeMasterAnalyzer.analyze(text != null ? text : session.getValue(), {
				objects: collectObjectNames(),
				external: INDEX_READY ? EXTERNAL : null,
				globals: INDEX_READY ? GLOBALS : null
			});
		} catch (e) {
			log("analysis failed:", e);
			data = { structs: [], vars: [], returns: {}, globals: {} };
		}
		try {
			registerStructs(data);
		} catch (e) {
			log("namespace registration failed:", e);
		}
		// The file being edited wins over the project index: `///@desc` added or reworded
		// a second ago must show up in the tooltip right away, without a reindex.
		try { mergeDocs(data.docs); } catch (e) { /* ignore */ }
		try { mergeFields(data.fields, true); } catch (e) { /* ignore */ }
		data.__gen = ++GEN;
		var entry = { session: session, time: now, data: data, sig: sig };
		CACHE = entry;
		if (CACHE_MAP != null) {
			try { CACHE_MAP.set(session, entry); } catch (e) { /* ignore */ }
		}
		return data;
	}

	// The aside pane's session is a *clone*: same document, same `gmlEditor` (so the same
	// import/local tables). Whatever the left pane injected is therefore already valid for
	// it, and re-running the whole injection on every keystroke in the right pane was pure
	// wasted work. Only a pane showing a *different* document needs its own pass.
	function needsInjection(session) {
		if (session == null) return false;
		var owner = session.gmlEditor;
		if (owner == null || owner.session == null) return true;
		if (owner.session === session) return true;
		return owner.session.doc !== session.doc;
	}

	var APPLY_BUSY = false;

	// Re-entrancy guard: injection touches the same import tables the completers and the
	// linter read, and an exception halfway through used to leave the tables half-built.
	function applyTo(session, row) {
		if (APPLY_BUSY) return;
		APPLY_BUSY = true;
		try { applyToInner(session, row); }
		finally { APPLY_BUSY = false; }
	}

	function applyToInner(session, row) {
		var code = session.gmlEditor;
		if (!code || !code.imports) return;
		var data = getData(session);
		if (!data) return;

		var TDef = G("gml.type.GmlTypeDef");
		var scopes = session.gmlScopes;
		var Imports = G("gml.GmlImports");

		// Must happen before mirrorStructs(): the struct namespaces a global points at have
		// to exist in this file's table as well, or `global.NAME.field.` stops at one level.
		try { applyGlobals(data); } catch (e) { log("global types failed:", e); }

		if (!FIRST_INJECT) {
			FIRST_INJECT = true;
			var first = null;
			try { first = scopes ? scopes.get(row) : null; } catch (e) { /* ignore */ }
			log("injection active: scope=" + first + ", vars=" + data.vars.length +
				", structs=" + data.structs.length);
		}

		// Every synthesized struct namespace has to be visible per import, otherwise nested
		// access (`u.pos.` -> `$tm.2`) cannot be resolved either. Re-done only when the
		// analysis generation changes, or when the editor replaced the import object.
		function mirrorStructs(imp) {
			if (imp == null) return;
			var last = data.structs.length ? NS_PREFIX + data.structs.length : null;
			// Skip only when the generation matches *and* the last namespace is still there
			// (a re-parse can replace the import object or clear its namespace table).
			if (imp.__tmGen === data.__gen && (last == null || imp.namespaces[last] != null)) return;
			imp.__tmGen = data.__gen;
			for (var si = 0; si < data.structs.length; si++) {
				mirrorToImport(imp, NS_PREFIX + (si + 1), { st: si + 1 });
			}
		}

		try {
			var curScope = scopes ? scopes.get(row) : null;
			if (curScope != null) {
				var curImp = code.imports[curScope];
				if (curImp == null) {
					curImp = new Imports();
					code.imports[curScope] = curImp;
				}
				mirrorStructs(curImp);
			}
		} catch (e) { /* ignore */ }

		for (var i = 0; i < data.vars.length; i++) {
			var v = data.vars[i];
			var tn = typeNameOf(v.type);
			// A `@is` sentence is worth showing even when the entry has no usable type
			// (`///@is 只是一句说明`), so that case must not bail out here.
			if (!tn && v.desc == null) continue;
			if (tn) ensureForType(v.type);

			var scope = null;
			try { scope = scopes ? scopes.get(v.row) : null; } catch (e) { scope = null; }
			if (scope == null) continue;

			// `///@is {T} 说明` - recorded before the type gate so prose-only hints work too.
			// `shortType` turns our synthesized `$tm.7` into `struct`: the sentence is shown
			// to a human, not written back into a type table.
			if (v.desc != null) rememberVarDesc(session, data.__gen, scope, v.name, v.desc, shortType(tn));
			if (!tn) continue;

			var imp = code.imports[scope];
			if (imp == null) {
				try {
					imp = new Imports();
					code.imports[scope] = imp;
				} catch (e) { continue; }
			}
			if (!imp.localTypes) continue;

			mirrorStructs(imp);

			var cur = imp.localTypes[v.name];
			if (cur == null || isOwnType(cur) || v.type.ex === true ||
				((v.type.obj != null || v.type.st != null) && isGenericInstanceType(cur))) {
				try {
					imp.localTypes[v.name] = TDef.simple(tn);
				} catch (e) { /* ignore */ }
			}
			if (v.type.obj != null) {
				var seenObj = imp.__tmObj || (imp.__tmObj = Object.create(null));
				if (seenObj[tn] !== data.__gen) {
					seenObj[tn] = data.__gen;
					mirrorToImport(imp, tn, v.type);
				}
			}
		}
	}

	// ---- last-resort fallback ------------------------------------------------
	// If the native popup comes back empty for `expr.`, answer it ourselves. This keeps
	// struct completion working even if a future GMEdit build changes the internal tables.

	function findVarType(data, name, row) {
		var best = null;
		for (var i = 0; i < data.vars.length; i++) {
			var v = data.vars[i];
			if (v.name !== name || v.row > row) continue;
			if (best == null || v.row >= best.row) best = v;
		}
		return best == null ? null : best.type;
	}

	function resolveChain(data, expr, row) {
		var parts = expr.split(".");
		var i = 1, t;
		if (parts[0] === "global") {
			// `global.CONFIG.field.` - the first part is the fixed `global` keyword.
			if (parts.length < 2) return null;
			t = (data.globals && data.globals[parts[1]]) || null;
			i = 2;
		} else {
			t = findVarType(data, parts[0], row);
		}
		for (; i < parts.length && t != null; i++) {
			if (t.st == null) return null;
			var fields = data.structs[t.st - 1];
			if (fields == null) return null;
			var next = null;
			for (var f = 0; f < fields.length; f++) {
				if (fields[f].name === parts[i]) { next = fields[f].type; break; }
			}
			if (next == null) return null;
			t = next;
		}
		return t;
	}

	function buildFallback(session, pos) {
		if (session == null || pos == null || typeof session.getLine !== "function") return null;
		var line;
		try { line = session.getLine(pos.row); } catch (e) { return null; }
		if (line == null) return null;
		var before = line.slice(0, pos.column);
		var m = /([A-Za-z_][A-Za-z0-9_]*)((?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*$/.exec(before);
		if (m == null) return null;
		var expr = m[1] + (m[2] || "").replace(/\s+/g, "");
		var data;
		try { data = getData(session); } catch (e) { return null; }
		if (data == null) return null;
		var t = resolveChain(data, expr, pos.row);
		if (t == null || t.st == null) return null;
		var fields = data.structs[t.st - 1];
		if (fields == null || fields.length === 0) return null;
		var out = [];
		for (var i = 0; i < fields.length; i++) {
			var tn = typeNameOf(fields[i].type);
			out.push({
				name: fields[i].name,
				value: fields[i].name,
				score: 0,
				meta: shortType(tn),
				doc: tn || ""
			});
		}
		if (!FALLBACK_LOGGED) {
			FALLBACK_LOGGED = true;
			log("fallback supplied " + out.length + " field(s) for `" + expr + ".` (logged once)");
		}
		return out;
	}

	// ---- middle-click: go to definition --------------------------------------
	// GMEdit already binds middle click to `ui.OpenDeclaration.proc`, which handles built-ins
	// (opens the manual), assets, enums, and anything its own project seeker indexed. Whatever
	// it cannot resolve falls through to our index, so user-defined functions, methods,
	// instance variables and locals become clickable too.

	// Names that GMEdit itself owns: engine functions / built-in variables (from its API
	// files), extension functions, and project assets, macros and enums. Those keep the
	// native behaviour - including "open the manual" - so they must never be redirected to a
	// same-named user symbol.
	function isKnownToEditor(name) {
		if (name == null) return false;
		try {
			var A = G("gml.GmlAPI");
			if (A.helpLookup != null && A.helpLookup[name] != null) return true;
			if (A.stdKind != null && A.stdKind[name] != null) return true;
			if (A.extKind != null && A.extKind[name] != null) return true;
			if (A.gmlKind != null && A.gmlKind[name] != null) return true;
			if (A.gmlNamespaces != null && A.gmlNamespaces[name] != null) return true;
			// Built-in *variables* (`x`, `y`, `visible`, ...) live in their own table.
			if (A.stdInstCompMap != null && A.stdInstCompMap[name] != null) return true;
			if (A.stdTypeExists != null && A.stdTypeExists[name] != null) return true;
		} catch (e) { /* ignore */ }
		return false;
	}

	// `_item_par_inst.Open_item()` -> "obj_item_parent", `global.CFG.owner.Run()` -> whichever
	// object `CFG.owner` was created as. Only the dotted chain directly left of the clicked
	// token is considered, and only when our own inference knows its type.
	function receiverObjectAt(session, pos) {
		if (session == null || pos == null) return null;
		var line;
		try { line = session.getLine(pos.row); } catch (e) { return null; }
		if (line == null) return null;
		var m = /([A-Za-z_][A-Za-z0-9_]*)((?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*$/
			.exec(line.slice(0, pos.column));
		if (m == null) return null;
		var expr = m[1] + (m[2] || "").replace(/\s+/g, "");
		var data;
		try { data = getData(session); } catch (e) { return null; }
		if (data == null) return null;
		var t = resolveChain(data, expr, pos.row);
		if (t == null) return null;
		if (t.nm != null) return t.nm;
		if (t.obj != null) return t.obj;
		return null;
	}

	// Several objects may define the same method name, and the index keeps up to MAX_DEFS of
	// them. Pick the one that belongs to the receiver's object when we know its type, then
	// the one in the file we are already in.
	function pickDefinition(list, session, pos, name) {
		var recv = null;
		try { recv = receiverObjectAt(session, pos); } catch (e) { /* ignore */ }
		var here = null;
		try { here = session.gmlFile ? session.gmlFile.path : null; } catch (e) { /* ignore */ }
		var called = false;
		try {
			called = /^[ \t]*\(/.test(session.getLine(pos.row).slice(pos.column + name.length));
		} catch (e) { /* ignore */ }
		var best = list[0], bestScore = -1;
		for (var i = 0; i < list.length; i++) {
			var d = list[i], s = 0;
			if (recv != null && d.obj === recv) s += 8;
			if (here != null && (d.file === here || d.path === here)) s += 4;
			if (called && (d.kind === "method" || d.kind === "function")) s += 2;
			if (s > bestScore) { bestScore = s; best = d; }
		}
		if (recv != null && best.obj !== recv) {
			log("no definition of `" + name + "` on " + recv + ", using " + (best.obj || baseName(best.path)));
		}
		return best;
	}

	function baseName(p) {
		var m = /([^\\/]+)$/.exec(p || "");
		if (m == null) return "?";
		return m[1].replace(/\.gml$/i, "");
	}

	// Inside an object buffer, locate the definition by scanning the matching `#event` block.
	// Text search (instead of `nav.pos`) stays correct even when GMEdit moves a file's `///`
	// header onto the `#event` line, which shifts every following row by one.
	function refineEventLocation(def) {
		try {
			var ed = window.Main && window.Main.aceEditor;
			var session = ed && ed.getSession();
			if (!session) return;
			var lines = session.getLength();
			var start = -1, end = lines;
			for (var i = 0; i < lines; i++) {
				var t = session.getLine(i);
				if (t.charAt(0) !== "#") continue;
				var mm = /^#(?:event|define|moment|target)[ \t]+(.+)$/.exec(t);
				if (mm == null) continue;
				if (start < 0) {
					if (mm[1].trim() === def.sub) start = i;
				} else { end = i; break; }
			}
			if (start < 0) return;
			// `var name = ...` / `name = ...` / `function name(...)`; a bare `name(...)` is a call,
			// not a definition, so it must not match.
			var rx = new RegExp("^(?:var|static|let|const)[ \\t]+" + def.name + "\\b|^" +
				def.name + "\\b[ \\t]*=(?!=)|^function[ \\t]+" + def.name + "\\b");
			for (var r = start + 1; r < end; r++) {
				if (rx.test(session.getLine(r).trim())) {
					ed.gotoLine(r + 1, 0);
					return;
				}
			}
			ed.gotoLine(start + 2, 0);
		} catch (e) { log("could not refine event location:", e); }
	}

	// Objects can share a method name (`L_release_func` is defined 19 times in this project) and
	// the index keeps only the first MAX_DEFS hits, so the receiver's own object may be missing.
	// Looking there directly is a couple of file reads and can never pick the wrong object.
	function findDefInObject(objName, name) {
		if (objName == null) return null;
		var root = projectRoot();
		if (root == null) return null;
		var fs = null, path = null;
		try {
			fs = require("fs");
			path = require("path");
		} catch (e) { return null; }
		var dir = path.join(root, "objects", objName);
		var files = [];
		try {
			var ents = fs.readdirSync(dir);
			for (var i = 0; i < ents.length; i++) {
				if (/\.gml$/i.test(ents[i])) files.push(path.join(dir, ents[i]));
			}
		} catch (e) { return null; }
		var loose = null;
		for (var f = 0; f < files.length; f++) {
			var src;
			try { src = fs.readFileSync(files[f], "utf8"); } catch (e) { continue; }
			var list;
			try { list = TypeMasterAnalyzer.defs(src); } catch (e) { continue; }
			for (var d = 0; d < list.length; d++) {
				var it = list[d];
				if (it.name !== name) continue;
				var info = eventInfoFor(files[f]);
				if (info == null) continue;
				var entry = { name: name, path: info.path, sub: info.sub, obj: info.obj,
					file: files[f], row: it.row, col: it.col, kind: it.kind };
				if (it.kind === "method" || it.kind === "function") return entry;   // preferred
				if (loose == null) loose = entry;
			}
		}
		return loose;
	}

	function objectOfPath(p) {
		var m = p == null ? null : /[\\/]objects[\\/]([^\\/]+)[\\/][^\\/]+\.yy$/i.exec(p);
		return m == null ? null : m[1];
	}

	// Where is this name defined? Returns a location descriptor, or null. Never opens a file:
	// callers decide whether to act on it, which lets us answer "can I jump?" *before*
	// touching the editor (or before muting the native handler).
	function resolveDefinition(session, pos, name) {
		if (session == null || name == null) return null;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

		// The project index starts 800ms after the plugin loads, but a project can be opened
		// much later, and until it exists `DEFS` is empty - which used to make the *first*
		// middle click of a session fall through to "open the manual". Building it right here
		// (it is a synchronous fs walk) costs a few hundred ms once and never again.
		ensureIndexNow();

		var recv = null;
		try { recv = receiverObjectAt(session, pos); } catch (e) { recv = null; }
		var hereObj = null;
		try { hereObj = objectOfPath(session.gmlFile && session.gmlFile.path); } catch (e) { /* ignore */ }

		// Definition in the buffer we are already in: works for freshly typed code that the
		// project index has not seen yet, and needs no file round-trip. Skipped when the
		// receiver clearly belongs to a different object.
		if (recv == null || hereObj == null || recv === hereObj) {
			try {
				var local = TypeMasterAnalyzer.defs(session.getValue());
				for (var li = 0; li < local.length; li++) {
					if (local[li].name !== name) continue;
					return { name: name, inBuffer: true, row: local[li].row,
						col: local[li].col, kind: local[li].kind };
				}
			} catch (e) { log("local definition scan failed:", e); }
		}

		if (recv != null) {
			var same = DEFS[name];
			if (same != null) {
				for (var si = 0; si < same.length; si++) {
					if (same[si].obj === recv) return same[si];
				}
			}
			// MAX_DEFS truncates popular names (`L_release_func` has 19 definitions here), so
			// the receiver's own object may simply be missing from the index.
			var direct = null;
			try { direct = findDefInObject(recv, name); } catch (e) { direct = null; }
			if (direct != null) return direct;
		}

		var list = DEFS[name];
		if (list == null || list.length === 0) return null;
		return pickDefinition(list, session, pos, name);
	}

	function doJump(pick, name) {
		if (pick == null) return false;
		if (pick.inBuffer) {
			var ed = (window.Main && window.Main.aceEditor) || window.aceEditor;
			if (ed == null) return false;
			try { ed.gotoLine(pick.row + 1, pick.col); } catch (e) { return false; }
			log("jump to " + name + " -> current buffer:" + (pick.row + 1) + " (" + pick.kind + ")");
			return true;
		}
		var GmlFile = G("gml.file.GmlFile");
		if (GmlFile == null) return false;
		try {
			if (pick.sub != null) {
				GmlFile.open(pick.obj, pick.path, { def: pick.sub });
				window.setTimeout(function () { refineEventLocation(pick); }, 60);
			} else {
				GmlFile.open(baseName(pick.path), pick.path,
					{ pos: { row: pick.row, column: pick.col } });
			}
		} catch (e) {
			log("jump failed:", e);
			return false;
		}
		log("jump to " + name + " -> " + pick.path + ":" + (pick.row + 1) + " (" + pick.kind + ")");
		return true;
	}

	// ---- middle click, primary path -----------------------------------------
	// GMEdit wires the middle button in `ui.KeyboardShortcuts.initEditor`, which is stored in
	// the native bundle and cannot be patched reliably (that handler calls
	// `ui.OpenDeclaration.proc` *and* ends in "open a manual search page" for anything it
	// cannot resolve - every user symbol, since a GMS 2.3+ API profile has no help index).
	//
	// So we take the click earlier, in the DOM capture phase: a plain document-level listener
	// sees `mousedown` before Ace gets it, so for a user symbol we jump and swallow the event,
	// and for anything else we return without touching the event, leaving the native
	// behaviour (manual page, asset jump, colour picker...) exactly as it was.
	var MID_HOOKED = false;

	// Ace stores a back-reference on its container (`container.aceEditor`), so walking up from
	// the event target finds the right editor instance - and returns null for clicks outside the
	// editor (tree view, tabs, toolbars), which must not be swallowed.
	// A freshly attached editor does not always have that back-reference yet, so fall back to
	// asking every editor whether the clicked node lives inside its container. Matching by
	// containment (instead of "the first editor on the page") keeps split view correct.
	function editorAt(el) {
		var node = el, host = null;
		while (node != null) {
			if (node.aceEditor != null) return node.aceEditor;
			if (host == null && node.classList != null && node.classList.contains("ace_editor")) host = node;
			node = node.parentNode;
		}
		if (host == null || el == null) return null;
		try {
			var els = document.querySelectorAll("pre.ace_editor");
			for (var i = 0; i < els.length; i++) {
				var ed = els[i].aceEditor;
				if (ed == null) continue;
				var c = ed.container;
				if (c === host || (c != null && typeof c.contains === "function" && c.contains(el))) return ed;
			}
		} catch (e) { /* ignore */ }
		return null;
	}

	// Clicks on the gutter / scrollbars / minimap are not "click on a symbol".
	function isChromeClick(el) {
		try {
			if (el == null || typeof el.closest !== "function") return false;
			return el.closest(".ace_gutter, .ace_scrollbar, .ace_minimap, .ace_fold-widget") != null;
		} catch (e) { return false; }
	}

	function middleClickResolver(e) {
		if (isChromeClick(e.target)) return false;
		var editor = editorAt(e.target);
		if (editor == null) return false;
		var pos = null;
		try { pos = editor.renderer.screenToTextCoordinates(e.clientX, e.clientY); } catch (x) { return false; }
		if (pos == null) return false;
		var session = editor.getSession();
		if (session == null) return false;
		var line = null;
		try { line = session.getLine(pos.row); } catch (x) { return false; }
		if (line == null || pos.column >= line.length) return false;   // same guard as the native one
		var token = session.getTokenAt(pos.row, pos.column);
		if (token == null) return false;
		var name = token.value;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || "")) return false;
		if (/^(comment|string)/.test(token.type || "")) return false;

		// Engine functions, built-in variables, assets, enums, macros: the native handler owns
		// these (manual page / tree navigation), so the click must not be consumed here.
		if (isKnownToEditor(name)) return false;

		var pick;
		try { pick = resolveDefinition(session, pos, name); } catch (x) { pick = null; }
		if (pick == null) {
			// Nothing of ours: the native handler decides. Keep one line of context around so a
			// "middle click did nothing" report can be answered without a debugger.
			log("no definition for `" + name + "` (index " + (INDEX_READY ? "ready" : "NOT ready") +
				", " + Object.keys(DEFS).length + " symbols)");
			return false;
		}

		// A definition was found, so the click belongs to us even if opening it fails (a
		// locked file, a half-loaded project). Letting it fall through would send it to the
		// manual page instead - which is exactly the behaviour this plugin exists to avoid.
		var jumped = false;
		try { jumped = doJump(pick, name) === true; } catch (x) { log("jump failed:", x); }
		if (!jumped) log("found a definition for `" + name + "` but could not open it (consumed the click)");
		return true;
	}

	function hookMiddleClick() {
		if (MID_HOOKED) return;
		MID_HOOKED = true;
		document.addEventListener("mousedown", function (e) {
			if (!enabled || e.button !== 1) return;
			var taken = false;
			try { taken = middleClickResolver(e); }
			catch (err) { log("middle-click handler failed:", err); }
			if (!taken) return;
			e.preventDefault();
			e.stopPropagation();
			if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
		}, true);
		log("middle-click go-to-definition hooked (capture phase)");
	}

	// ---- middle click, fallback ---------------------------------------------
	// If the capture listener did not take the click (unusual token types, a second editor
	// instance, ...), the native handler still runs. Mute only its last step - "open a manual
	// search page" - and jump ourselves when we can, so the click never ends up in a browser.
	function hookOpenDeclaration() {
		var OD = G("ui.OpenDeclaration");
		if (OD == null || typeof OD.proc !== "function" || OD.__tmHooked) return;
		OD.__tmHooked = true;
		var orig = OD.proc;
		OD.proc = function (session, pos, token) {
			var name = token && token.value;
			var known = name != null && isKnownToEditor(name);
			var pick = null;
			if (name != null && !/^(comment|string)/.test(token.type || "") && !known) {
				try { pick = resolveDefinition(session, pos, name); } catch (e) { pick = null; }
			}
			var API = G("gml.GmlAPI"), savedURL = null, muted = false;
			// Mute the manual branch in two cases: we have a jump target (native must not open
			// a page first), and the name is unknown to GMEdit (a "search the manual for this
			// user symbol" page is never what the user wanted). Built-ins keep their page.
			if (API != null && API.helpURL != null && (pick != null || (name != null && !known))) {
				savedURL = API.helpURL;
				try { API.helpURL = null; muted = true; } catch (e) { muted = false; }
			}
			var handled = false;
			try { handled = orig.apply(this, arguments); }
			catch (e) { log("native openDeclaration failed:", e); }
			if (muted) { try { API.helpURL = savedURL; } catch (e) { /* ignore */ } }
			if (handled) return true;                 // asset / enum / colour / native page
			if (pick == null) return false;           // nothing of ours and nothing native
			try { return doJump(pick, name); }
			catch (e) { log("jump failed:", e); return false; }
		};
		log("openDeclaration fallback hooked");
	}

	// ---- outline view: list what each event declares -------------------------
	// The built-in `outline-view` plugin stops at `#event create`. Its member regexes demand
	// leading indentation while object events are written flush left, and it never looks at
	// plain variables at all. We replace its gml mode handler with one that also lists
	// `name = function()` / `var name =` members declared directly inside the event
	// (brace depth 0), each with its own glyph, so the tree reads as
	//   create
	//     ƒ L_release_func
	//     ▪ hp

	var OV_RETRY = 0;
	var OV_TIMER = null;
	var OV_HOOKED = false;
	var OV_TAIL = " ➜ ";

	var rxOvDef = /^((#event)|#define|#moment|#section|#roomcc)\b\s*(\w+(?::\w+)?)(.*)$/;
	var rxOvFunc = /^function\s+(\w+)\s*(\(.*?\))(?:.*?\/\/(.*))?/;
	var rxOvMethod = /^\s*(?:(?:var|static|let|const)[ \t]+)?(\w+)[ \t]*=[ \t]*function\b[ \t]*(\([^)]*\))?/;
	var rxOvNamed = /^\s*function\s+(\w+)[ \t]*(\([^)]*\))?/;
	var rxOvShort = /^\s*(?:static[ \t]+)?(\w+)[ \t]*=[ \t]*(\([^)]*\))[ \t]*=>[ \t]*\{/;
	var rxOvVar = /^\s*(?:var|static|let|const)[ \t]+(\w+)[ \t]*=(?![=>])/;
	var rxOvCtx = /^\s*((?:#region|\/\/#region|\/\/#mark)\b.*)$/;
	var rxOvPush = /^\s*((?:#region|\/\/#region)\b\s*(.*))$/;
	var rxOvPop = /^\s*(?:#endregion|\/\/#endregion)\b/;
	var rxOvMark = /^\s*((?:\/\/#mark|#section)\b\s*(.*))$/;

	function ovPref(name, dflt) {
		try {
			var P = G("ui.Preferences");
			var ov = P && P.current ? P.current.outlineView : null;
			if (ov != null && ov[name] !== undefined) return ov[name];
		} catch (e) { /* ignore */ }
		return dflt;
	}

	// Brace depth at the *start* of every line, computed on a masked copy so braces inside
	// strings and comments do not count. Depth 0 == declared directly in the event.
	// `preMasked` lets the caller hand in a mask it already computed (the outline does).
	function braceDepthByLine(text, n, preMasked) {
		var out = new Array(n);
		var masked = preMasked != null ? preMasked : text;
		if (preMasked == null) {
			try { masked = TypeMasterAnalyzer.mask(text); } catch (e) { /* use raw */ }
		}
		var lines = String(masked).split("\n");
		var depth = 0;
		for (var i = 0; i < n; i++) {
			out[i] = depth;
			var s = lines[i] || "";
			for (var k = 0; k < s.length; k++) {
				var c = s.charCodeAt(k);
				if (c === 123) depth++;
				else if (c === 125 && depth > 0) depth--;
			}
		}
		return out;
	}

	function ovMemberNav(kind, name, def, showAtTop) {
		var rx;
		if (kind === "fn") {
			rx = new RegExp("\\b" + name + "\\b\\s*=\\s*function\\b|\\bfunction\\s+" + name + "\\b");
		} else if (kind === "short") {
			rx = new RegExp("\\b" + name + "\\b\\s*=\\s*\\(");
		} else {
			rx = new RegExp("\\b(?:var|static|let|const)\\s+" + name + "\\b");
		}
		return {
			def: def,
			ctx: name,
			ctxRx: rx,
			ctxAfter: true,
			showAtTop: showAtTop,
			outlineViewData: kind === "var" ? "tm_var" : "tm_fn"
		};
	}

	function reindexGml(file, ctx) {
		var doc = file.codeEditor.session.doc;
		var n = doc.getLength();
		var rows = [], i;
		for (i = 0; i < n; i++) rows.push(doc.getLine(i));
		var text = rows.join("\n");
		// Commented-out code is still code to a line regex: a `/* ... */` block holding an
		// old copy of the event used to be indexed as live members (the outline listed
		// functions that no longer exist). `mask` blanks out comments and string bodies
		// while keeping offsets and newlines, so a line whose masked form has no code left
		// is a comment - skip it. Regions and marks are exempted below, because they *are*
		// comments (`//#region`).
		var masked = "";
		try { masked = TypeMasterAnalyzer.mask(text); } catch (e) { masked = ""; }
		var depth = braceDepthByLine(text, n, masked !== "" ? masked : null);
		var showArgs = ovPref("showFuncArgs", true);
		var showAtTop = ovPref("showAtTop", true);
		var def = null;                     // enclosing #event / #define / function
		var defIsEvent = false;             // an #event section owns everything until the next one
		var maskedRows = masked !== "" ? masked.split("\n") : null;
		for (var row = 0; row < n; row++) {
			var line = rows[row], mt, label, title, nav, tail;
			// Regions and marks are comments themselves (`//#region`, `//#mark`), so they
			// must be exempt or the guard below would erase every one of them.
			var isRegion = rxOvPush.test(line) || rxOvPop.test(line) || rxOvMark.test(line);
			if (!isRegion && maskedRows != null && maskedRows[row] != null &&
				maskedRows[row].replace(/\s/g, "") === "") continue;   // blank or commented out
			// --- #event / #define / ... : a new top level node
			if ((mt = rxOvDef.exec(line)) != null) {
				def = mt[3];
				defIsEvent = true;
				label = def;
				title = mt[1] + " " + def;
				tail = (mt[4] || "").trim();
				if (tail && def !== "properties") {
					label += OV_TAIL + tail;
					title += "\n" + tail;
				}
				nav = { def: def, ctxAfter: true, showAtTop: showAtTop };
				if (mt[1]) nav.outlineViewData = "gml_" + def;
				ctx.flush(label, title, nav);
				continue;
			}
			// --- top level `function name()`: a new node as well
			if ((mt = rxOvFunc.exec(line)) != null) {
				def = mt[1];
				defIsEvent = false;
				label = def;
				title = "function " + def;
				if (showArgs) label += mt[2];
				title += mt[2];
				tail = (mt[3] || "").trim();
				if (tail) { label += OV_TAIL + tail; title += "\n" + tail; }
				ctx.flush(label, title, { def: def, ctxAfter: true, showAtTop: showAtTop });
				continue;
			}
			// --- members, but only the ones declared right in this event/function
			if (depth[row] === 0) {
				var kind = null, name = null, args = "";
				if ((mt = rxOvMethod.exec(line)) != null) { kind = "fn"; name = mt[1]; args = mt[2] || ""; }
				else if ((mt = rxOvNamed.exec(line)) != null) { kind = "fn"; name = mt[1]; args = mt[2] || ""; }
				else if ((mt = rxOvShort.exec(line)) != null) { kind = "short"; name = mt[1]; args = mt[2] || ""; }
				else if ((mt = rxOvVar.exec(line)) != null) { kind = "var"; name = mt[1]; }
				if (kind != null) {
					var label2 = name + (showArgs && kind !== "var" ? args : "");
					var memberNav = ovMemberNav(kind, name, def, showAtTop);
					if (defIsEvent) {
						ctx.mark(label2, line.trim(), memberNav);         // inside an #event section
					} else {
						// flush left in a script: a landmark of its own, sibling of the functions
						ctx.flush(label2, line.trim(), memberNav);
					}
					continue;
				}
			}
			// --- regions and marks (unchanged from the original plugin)
			if ((mt = rxOvPush.exec(line)) != null) {
				ctx.push(mt[2], mt[0], { def: def, ctx: mt[1], ctxAfter: true, showAtTop: showAtTop });
			} else if (rxOvPop.test(line)) {
				ctx.pop();
			} else if ((mt = rxOvMark.exec(line)) != null) {
				ctx.mark(mt[2], mt[0], { def: def, ctx: mt[1], ctxAfter: true, showAtTop: showAtTop });
			}
		}
	}

	// Same walk as the original `update`, but aware of flush-left members and variables, so
	// the "you are here" highlight lands on them too. When the split view owns the focus,
	// the caret and the document come from the aside pane instead of `file.codeEditor`.
	function updateGml(file, pos) {
		// `outline-view` walks the caret upwards by calling this over and over with
		// `pos.row -= 1` (see its own `update()`), looking for a tree item that matches
		// `pos.ctx`. That loop has no iteration cap of its own - it relies on `pos.row`
		// shrinking until it drops below zero. So the one thing this function must never
		// do is hand back a row that is not smaller than the one it was given: if it does,
		// the loop spins forever and the whole editor locks up (window keeps repainting the
		// blinking cursor, but nothing else runs and no click or key ever lands).
		//
		// The split view did exactly that: it restarted from the aside caret on *every*
		// call, discarding the descending row, so a right-pane `ctx` that the visible tree
		// does not contain was enough to freeze GMEdit.
		if (pos.__tmCalls == null) pos.__tmCalls = 0;
		if (++pos.__tmCalls > 2000) {                 // cannot happen now; kept as a hard stop
			pos.def = null; pos.ctx = null; pos.row = -1;
			return;
		}
		var pane = paneDocRow(file);
		var doc = pane != null ? pane.doc : file.codeEditor.session.doc;
		var seeded = false;
		var row;
		// `def`/`ctx` are only filled once something has been resolved, and the caller's
		// probe loop requires `pos.ctx` to be set - so "both still empty" reliably means
		// "this is the first call of an update", without keeping state on `pos`.
		if (pane != null && pos.def == null && pos.ctx == null) {
			// First call for this `pos`: the caret that matters is the focused pane's.
			// After that the caller is probing, and its row wins.
			seeded = true;
			row = pane.row;
		} else if (typeof pos.row === "number" && pos.row === pos.row) {
			row = pos.row;
		} else {
			row = pane != null ? pane.row : 0;
		}
		var def = pos.def;
		var ctxName = null, ctxRow = null;
		// Same comment blindness as `reindexGml`: a `/* ... */` block parks dead code on
		// rows the outline no longer lists, and matching one of those would hand the tree a
		// `ctx` that has no node. Masked once per update (the probe below calls this in a
		// loop, so it must not be recomputed per row) and cached on `pos`.
		var ml = maskedLinesFor(doc, pos);
		for (; row >= 0; row--) {
			var text = doc.getLine(row), mt;
			if (ml != null && ml[row] != null && ml[row].replace(/\s/g, "") === "" &&
				!(rxOvPush.test(text) || rxOvPop.test(text) || rxOvMark.test(text) ||
					rxOvCtx.test(text))) continue;      // blank or commented out
			if ((mt = rxOvDef.exec(text)) != null) { def = mt[3]; break; }
			if ((mt = rxOvFunc.exec(text)) != null) { def = mt[1]; break; }
			if (ctxName != null) continue;
			if ((mt = rxOvCtx.exec(text)) != null) {
				ctxName = mt[1]; ctxRow = row;
				if (def != null) break;
				continue;
			}
			if ((mt = rxOvMethod.exec(text)) != null) {
				ctxName = mt[1]; ctxRow = row;
				if (def != null) break;
				continue;
			}
			if ((mt = rxOvShort.exec(text)) != null) {
				ctxName = mt[1]; ctxRow = row;
				if (def != null) break;
				continue;
			}
			if ((mt = rxOvVar.exec(text)) != null) {
				ctxName = mt[1]; ctxRow = row;
				if (def != null) break;
			}
		}
		pos.def = def;
		pos.ctx = ctxName;
		var next = ctxRow != null ? ctxRow : row;
		// The probe must make progress on every call after the first one, otherwise the
		// caller's `while` can repeat the same row indefinitely. Clamping is a no-op for
		// the normal path (a scan upwards already returns a row below the caret), it only
		// catches the case where `ctxRow` equals the row we were handed.
		if (!seeded && pos.__tmWalked === true &&
			typeof pos.row === "number" && next >= pos.row) {
			next = pos.row - 1;
		}
		pos.__tmWalked = true;
		pos.row = next;
	}

	// Masked lines for the document behind `doc`, computed at most once per outline update.
	// The `pos` object lives for exactly one `update()` call (outline-view reuses it across
	// its upwards probe), so parking the array on it gives the right lifetime for free.
	function maskedLinesFor(doc, pos) {
		if (pos.__tmMaskedDone === true) return pos.__tmMasked;
		pos.__tmMaskedDone = true;
		pos.__tmMasked = null;
		try {
			pos.__tmMasked = TypeMasterAnalyzer.mask(doc.getValue()).split("\n");
		} catch (e) { pos.__tmMasked = null; }
		return pos.__tmMasked;
	}

	function hookOutlineView() {
		if (!enabled || OV_HOOKED) return;
		var PM = G("plugins.PluginManager");
		var reg = PM && PM.registry && PM.registry.h ? PM.registry.h["outline-view"] : null;
		var data = reg ? reg.data : null;
		var map = data && data._modeMap;
		var gml = map ? map["ace/mode/gml"] : null;
		if (gml == null) {
			// the other plugin may still be loading; it is cheap to look again later
			if (OV_TIMER != null || OV_RETRY++ >= 12) return;
			OV_TIMER = window.setTimeout(function () {
				OV_TIMER = null;
				hookOutlineView();
			}, 700);
			return;
		}
		if (gml.__tmPatched) { OV_HOOKED = true; return; }
		gml.__tmPatched = true;
		OV_HOOKED = true;
		var origReindex = gml.reindex;
		var origUpdate = gml.update;
		gml.reindex = function (file, ctx) {
			try { return reindexGml(file, ctx); }
			catch (e) {
				log("outline reindex failed, falling back:", e);
				return origReindex.apply(this, arguments);
			}
		};
		gml.update = function (file, pos) {
			try { return updateGml(file, pos); }
			catch (e) { log("outline update failed, falling back:", e); return origUpdate.apply(this, arguments); }
		};
		log("outline view extended: event members are listed");
	}

	// ---- split view (`show-aside`): follow the pane that owns the focus ------------
	// The built-in `show-aside` plugin builds a *second* Ace instance over a clone of the
	// file's session. `GmlFile.current` keeps pointing at the left tab, so `outline-view`
	// always mirrors the left pane. When the aside pane owns the focus we hand the outline
	// a stand-in file whose `codeEditor` is the aside editor: `changeTo` then reindexes the
	// right document, and the update path reads the right caret.
	var ASIDE_EDITOR = null;
	var ASIDE_FILE = null;        // stand-in GmlFile for the aside pane
	var ASIDE_ACTIVE = false;
	var ASIDE_DIRTY = false;
	var ASIDE_REUSED = false;   // the aside shows the same file: its tree is reused
	var EMIT_BUSY = false;
	var ASIDE_INJECTED = null;   // which aside session we already injected types for
	var ASIDE_WATCH = null;
	var TAB_MENU_HOOKED = false;   // "Open in aside pane" is on the main tab menu
	var FILE_CLOSE_HOOKED = false; // closed files are dropped from the aside strip

	function asideContainer() {
		var el = document.getElementById("aside_editor");
		return el == null ? null : el;
	}

	function findAsideEditor() {
		var box = asideContainer();
		if (box == null) return null;
		var el = box.querySelector(".ace_editor");
		if (el != null && el.aceEditor != null) return el.aceEditor;
		if (box.aceEditor != null) return box.aceEditor;
		return null;
	}

	function outlineTree() {
		return document.querySelector("#outline-view .treeview");
	}

	// `aceEditor` is a global in GMEdit's own script; fall back to the window property in
	// case that ever changes.
	function mainEditor() {
		try {
			if (typeof aceEditor !== "undefined" && aceEditor != null) return aceEditor;
		} catch (e) { /* ignore */ }
		return window.aceEditor || null;
	}

	function escapeRxText(s) {
		return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	// Find the row a nav entry points at *without* touching the main editor - the native
	// `kind.navigate` hard-codes `Main.aceEditor`, which would drag the left pane along.
	function navRowIn(session, nav) {
		var len = session.getLength(), row = -1, i;
		if (nav.def != null) {
			var d = escapeRxText(nav.def);
			var rxDef = new RegExp("^[ \\t]*(?:(?:#event|#define|#moment|#section|#roomcc)[ \\t]+)?" +
				d + "\\b|^[ \\t]*function[ \\t]+" + d + "\\b");
			for (i = 0; i < len; i++) {
				if (rxDef.test(session.getLine(i))) { row = i; break; }
			}
		}
		if (nav.ctx != null) {
			var test;
			if (nav.ctxRx instanceof RegExp) {
				var rx = nav.ctxRx;
				test = function (s) { rx.lastIndex = 0; return rx.test(s); };
			} else {
				var needle = String(nav.ctx);
				test = function (s) { return s.indexOf(needle) >= 0; };
			}
			var start = row >= 0 ? row : 0;
			for (i = start; i < len; i++) {
				if (i === row) continue;             // the def line itself is not the target
				if (test(session.getLine(i))) { row = i; break; }
			}
		}
		return row;
	}

	function navigateAside(editor, nav) {
		try {
			var row = navRowIn(editor.session, nav);
			if (row < 0) return false;
			if (nav.showAtTop !== false) editor.scrollToLine(row);
			editor.gotoLine(row + 1, 0);
			editor.focus();
			return true;
		} catch (e) { log("aside navigate failed:", e); return false; }
	}

	function pluginSignal(name, data) {
		var PA = G("plugins.PluginAPI");
		if (PA == null || typeof PA._signal !== "function") return false;
		try { PA._signal(name, data); return true; }
		catch (e) { log("signal '" + name + "' failed:", e); return false; }
	}

	function asideFileFor(editor) {
		var base = editor && editor.session ? editor.session.gmlFile : null;
		if (base == null) return null;
		if (ASIDE_FILE != null && ASIDE_FILE.__tmBase === base && ASIDE_FILE.codeEditor === editor) {
			return ASIDE_FILE;
		}
		if (ASIDE_FILE != null && ASIDE_FILE.outlineView != null) {
			var old = ASIDE_FILE.outlineView;
			if (old.parentElement != null) old.parentElement.removeChild(old);
		}
		// Prototype-chained on purpose: anything we do not override (kind, save, path, ...)
		// keeps working, only the editor and the label differ.
		var p = Object.create(base);
		p.__tmAside = true;
		p.__tmBase = base;
		p.name = (base.name || "file") + " (aside)";
		p.codeEditor = editor;
		p.tabEl = null;                    // `activateFile` must not click the left tab
		p.outlineView = null;
		p.navigate = function (nav) { return navigateAside(editor, nav); };
		ASIDE_FILE = p;
		return p;
	}

	function markOutlineCurrent(node) {
		var tv = outlineTree();
		if (node == null || tv == null) return;
		if (node.parentElement !== tv) tv.appendChild(node);
		node.classList.add("open");
		var curr = tv.querySelectorAll(".outline-current-file");
		for (var i = 0; i < curr.length; i++) {
			if (curr[i] !== node) curr[i].classList.remove("outline-current-file");
		}
		node.classList.add("outline-current-file");
	}

	function ensurePinned() {
		if (!ASIDE_ACTIVE || ASIDE_FILE == null) return;
		markOutlineCurrent(ASIDE_FILE.outlineView);
	}

	function pinAside() {
		var ed = findAsideEditor();
		if (ed == null) return;
		// Typing in the aside no longer re-runs the injection (same document as the left
		// pane), so do it once here - otherwise a file that was only ever edited from the
		// right side would show no `$tm` fields at all.
		if (ed.session != null && ASIDE_INJECTED !== ed.session) {
			ASIDE_INJECTED = ed.session;
			try { applyTo(ed.session, ed.session.selection.lead.row); }
			catch (e) { log("aside inject failed:", e); }
		}
		var proxy = asideFileFor(ed);
		if (proxy == null) return;

		// `show-aside` always starts from the active file, so the usual case is "both panes
		// show the same document". Its tree is already in the sidebar and its content is
		// identical - building a second, near-identical tree would just be noise, so we only
		// move the "current" marker there; the highlight still follows the right pane because
		// updateGml reads the aside caret.
		var cur = null;
		try { cur = G("gml.file.GmlFile").current; } catch (e) { /* ignore */ }
		if (cur != null && proxy.__tmBase === cur && cur.outlineView != null) {
			ASIDE_REUSED = true;
			if (ASIDE_FILE.outlineView != null) {
				var stale = ASIDE_FILE.outlineView;
				stale.classList.remove("outline-current-file");
				if (stale.parentElement != null) stale.parentElement.removeChild(stale);
				ASIDE_FILE.outlineView = null;
			}
			markOutlineCurrent(cur.outlineView);
			return;
		}

		ASIDE_REUSED = false;
		if (ASIDE_DIRTY) {
			var old = proxy.outlineView;
			if (old != null && old.parentElement != null) old.parentElement.removeChild(old);
			proxy.outlineView = null;
			ASIDE_DIRTY = false;
		}
		pluginSignal("activeFileChange", { file: proxy });
		ensurePinned();
	}

	function unpinAside() {
		ASIDE_ACTIVE = false;
		if (!ASIDE_REUSED) {
			// only the stand-in tree needs the real file put back in charge
			var cur = null;
			try { cur = G("gml.file.GmlFile").current; } catch (e) { /* ignore */ }
			if (cur != null) pluginSignal("activeFileChange", { file: cur });
		}
		ASIDE_REUSED = false;
		dropAsideTree();
	}

	function dropAsideTree() {
		if (ASIDE_FILE == null || ASIDE_FILE.outlineView == null) return;
		var node = ASIDE_FILE.outlineView;
		node.classList.remove("outline-current-file");
		if (node.parentElement != null) node.parentElement.removeChild(node);
		ASIDE_FILE.outlineView = null;
	}

	// Clicking a tab blurs whatever had the focus (`mousedown` default on a non-focusable
	// element), so without this the aside would be considered "inactive" a moment later and
	// the next click would go native again. Always hand the focus back to the right pane.
	function refocusAside(ed) {
		try { if (ed != null && typeof ed.focus === "function") ed.focus(); } catch (e) { /* ignore */ }
		try { syncAsideFocus(); } catch (e) { /* ignore */ }
	}

	// `show-aside` clones whatever file was active when it opened and has no way to change
	// its mind afterwards - its own copy of `gmlFile`/`session` is private. Rebuilding the
	// clone is enough: the pane then shows the new file while the tab bar (and the left
	// pane) stay exactly where they were.
	function switchAsideTo(ed, file) {
		try {
			if (ed == null || file == null) return false;
			var src = file.codeEditor != null ? file.codeEditor.session : null;
			if (src == null) return false;
			if (ed.session != null && ed.session.doc === src.doc) {
				refocusAside(ed);              // already showing it: only the focus was lost
				return true;
			}
			var tools = null;
			try { tools = window.GMEdit != null ? window.GMEdit.aceTools : null; } catch (e) { tools = null; }
			if (tools == null || typeof tools.cloneSession !== "function") {
				log("aceTools.cloneSession is unavailable: cannot switch the aside pane");
				return false;
			}
			var clone = tools.cloneSession(src);
			dropAsideTree();
			ASIDE_FILE = null;                 // the stand-in is per base file
			ASIDE_DIRTY = true;
			ASIDE_REUSED = false;
			ASIDE_INJECTED = null;
			ed.setSession(clone);
			try { addAsideTab(file); renderAsideTabs(); } catch (e2) { /* ignore */ }
			log("aside pane switched to " + (file.name || file.path || "?"));
			window.setTimeout(function () {
				refocusAside(ed);
			}, 0);
			return true;
		} catch (e) {
			log("aside switch failed:", e);
			return false;
		}
	}

	// ---- the aside pane gets its own tab strip ---------------------------------
	// `show-aside` clones one file when it opens and keeps the clone in a private variable,
	// so there is no way to switch files from the outside. An earlier attempt captured
	// clicks on the *main* tab bar and that was wrong twice over:
	//   - `chrome-tabs` activates a tab in its `click` handler, so the native flow still ran
	//     and took the left pane (and the focus, via `Main.aceEditor.focus()`) with it;
	//   - one tab bar for two panes is the wrong model anyway: it kept showing the left
	//     pane's file, so it never said which file the right pane had.
	// So the aside gets a strip of its own, the way a second editor group works in VS Code:
	// the main tab bar goes back to being purely the left pane's, this one owns the right.
	var ASIDE_TABS = [];          // GmlFile list, in strip order
	var ASIDE_TABS_EL = null;     // the strip element (lives in #aside_editor)
	var ASIDE_TABS_SIG = null;    // last rendered signature, to skip no-op re-renders
	var TAB_MENU_ITEM = null;     // "Open in aside pane" entry on the main tab menu

	function closestWithClass(node, cls, max) {
		var n = node, guard = 0;
		var limit = max || 6;
		while (n != null && guard++ < limit) {
			if (n.classList != null && n.classList.contains(cls)) return n;
			n = n.parentNode;
		}
		return null;
	}

	function currentAsideFile(ed) {
		var ed2 = ed !== undefined ? ed : findAsideEditor();
		var s = ed2 != null ? ed2.session : null;
		return s != null && s.gmlFile != null ? s.gmlFile : null;
	}

	function asideTabIndex(file) {
		for (var i = 0; i < ASIDE_TABS.length; i++) {
			if (ASIDE_TABS[i] === file) return i;
		}
		return -1;
	}

	function tabTitleOf(file) {
		if (file == null) return "?";
		if (file.name != null && file.name !== "") return file.name;
		return file.path || "?";
	}

	// Create (once) and keep the strip attached as the first child of `#aside_editor`.
	// That container is already `.ace_container` - `display:flex; flex-direction:column`
	// with `.ace_editor { flex-grow:1 }` - so a fixed-height bar simply takes its share and
	// the editor shrinks; no layout surgery needed.
	function ensureAsideTabs(ed) {
		if (!enabled) return;
		var box = asideContainer();
		if (box == null) {
			ASIDE_TABS.length = 0;
			ASIDE_TABS_SIG = null;
			return;
		}
		if (ASIDE_TABS_EL == null) {
			var bar = document.createElement("div");
			bar.className = "tm-aside-tabs";
			// Clicks here must not reach the editor or the main tab bar.
			bar.addEventListener("mousedown", function (e) { e.stopPropagation(); });
			bar.addEventListener("click", onAsideTabClick);
			bar.addEventListener("auxclick", onAsideTabAuxClick);
			bar.addEventListener("wheel", function (e) {
				if (!e.deltaY || e.deltaX) return;
				if (bar.scrollWidth <= bar.clientWidth) return;
				bar.scrollLeft += e.deltaY;
				e.preventDefault();
			}, { passive: false });
			ASIDE_TABS_EL = bar;
		}
		if (ASIDE_TABS_EL.parentElement !== box) {
			box.insertBefore(ASIDE_TABS_EL, box.firstChild);
			// The editor was laid out before this bar existed.
			try { if (ed != null && typeof ed.resize === "function") ed.resize(true); } catch (e) { /* ignore */ }
		}
		var cur = currentAsideFile(ed);
		if (cur != null && asideTabIndex(cur) < 0) ASIDE_TABS.push(cur);
		renderAsideTabs();
	}

	function renderAsideTabs() {
		var el = ASIDE_TABS_EL;
		if (el == null) return;
		var cur = currentAsideFile();
		var parts = [];
		for (var i = 0; i < ASIDE_TABS.length; i++) {
			var f = ASIDE_TABS[i];
			parts.push(tabTitleOf(f) + (f === cur ? "*" : "") + "|" + (f.path || ""));
		}
		var sig = parts.join("\n");
		if (sig === ASIDE_TABS_SIG) {
			// Same tabs: still make sure the marker is right, without rebuilding the DOM.
			var marked = el.querySelector(".tm-aside-tab-current");
			if (marked != null && marked.__tmFile === cur) return;
		}
		ASIDE_TABS_SIG = sig;
		while (el.firstChild != null) el.removeChild(el.firstChild);
		for (i = 0; i < ASIDE_TABS.length; i++) {
			var file = ASIDE_TABS[i];
			var tab = document.createElement("div");
			tab.className = "tm-aside-tab" + (file === cur ? " tm-aside-tab-current" : "");
			tab.__tmFile = file;
			tab.title = tabTitleOf(file) + (file.path ? "\n" + file.path : "");
			var label = document.createElement("span");
			label.className = "tm-aside-tab-title";
			label.textContent = tabTitleOf(file);
			var close = document.createElement("span");
			close.className = "tm-aside-tab-close";
			close.textContent = "\u00d7";
			tab.appendChild(label);
			tab.appendChild(close);
			el.appendChild(tab);
		}
		var act = el.querySelector(".tm-aside-tab-current");
		if (act != null && typeof act.scrollIntoView === "function") {
			try { act.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e2) { /* ignore */ }
		}
	}

	function addAsideTab(file) {
		if (file == null) return false;
		if (asideTabIndex(file) < 0) ASIDE_TABS.push(file);
		return true;
	}

	// Switching shows the file in the right pane; it does not touch the left one, and it
	// does not touch the main tab bar either (nothing there is "current" for this pane).
	function activateAsideFile(file) {
		var ed = findAsideEditor();
		if (ed == null || file == null) return false;
		addAsideTab(file);
		var ok = switchAsideTo(ed, file);
		renderAsideTabs();
		refocusAside(ed);
		return ok;
	}

	// Closing the last tab closes the pane with it: a second editor group with no file to
	// show makes no sense (VS Code behaves the same way). Everything the strip owns is
	// dropped first, because `hide()` takes `#aside_editor` - and the bar inside it - out
	// of the document; `ensureAsideTabs` then builds a fresh strip when the pane comes back.
	function closeAsidePane() {
		ASIDE_TABS.length = 0;
		ASIDE_TABS_SIG = null;
		if (ASIDE_TABS_EL != null) {
			try {
				if (ASIDE_TABS_EL.parentNode != null) {
					ASIDE_TABS_EL.parentNode.removeChild(ASIDE_TABS_EL);
				}
			} catch (e) { /* ignore */ }
			ASIDE_TABS_EL = null;
		}
		// Hand the outline back to the left pane *before* the editor disappears: once it
		// is gone `findAsideEditor` returns null and `syncAsideFocus` can only shrug, so
		// the stand-in tree (and `GmlFile.current`) would stay where the right pane left
		// them.
		if (ASIDE_ACTIVE || ASIDE_FILE != null) {
			try { unpinAside(); } catch (e2) { log("aside unpin failed:", e2); }
		}
		var ok = hideAsidePane();
		if (!ok) log("aside: could not close the right pane");
		ASIDE_EDITOR = null;
		ASIDE_ACTIVE = false;
		try { syncAsideFocus(); } catch (e3) { /* ignore */ }
		return ok;
	}

	function removeAsideTab(file) {
		var i = asideTabIndex(file);
		if (i < 0) return false;
		if (ASIDE_TABS.length <= 1) return closeAsidePane();
		var ed = findAsideEditor();
		var cur = currentAsideFile(ed);
		ASIDE_TABS.splice(i, 1);
		if (file === cur) {
			var next = ASIDE_TABS[i] != null ? ASIDE_TABS[i] : ASIDE_TABS[i - 1];
			if (next != null) activateAsideFile(next);
		}
		renderAsideTabs();
		return true;
	}

	function onAsideTabClick(e) {
		try {
			if (!enabled) return;
			var tab = closestWithClass(e.target, "tm-aside-tab");
			if (tab == null || tab.__tmFile == null) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.target != null && e.target.closest != null &&
				e.target.closest(".tm-aside-tab-close") != null) {
				removeAsideTab(tab.__tmFile);
				return;
			}
			activateAsideFile(tab.__tmFile);
		} catch (err) {
			log("aside tab click failed:", err);
		}
	}

	function onAsideTabAuxClick(e) {
		if (e.button !== 1) return;
		var tab = closestWithClass(e.target, "tm-aside-tab");
		if (tab == null || tab.__tmFile == null) return;
		e.preventDefault();
		e.stopPropagation();
		removeAsideTab(tab.__tmFile);
	}

	// `Open in aside pane` on the main tab's context menu - the explicit way to put a file
	// into the right group (VS Code: "Open to the Side"). GMEdit already signals `tabMenu`
	// right before it pops the menu up, so one item can be appended once and reused.
	function installTabMenuItem() {
		if (TAB_MENU_ITEM != null) return;
		var TM = G("ui.ChromeTabMenu");
		var MI = window.Electron_MenuItem;
		if (TM == null || TM.menu == null || typeof MI !== "function") return;
		TAB_MENU_ITEM = new MI({
			id: "tm-open-in-aside",
			label: "Open in aside pane",
			click: function () {
				try {
					var target = TM.target;
					var file = target != null ? target.gmlFile : null;
					if (file == null) return;
					var ed = ensureAsideOpen();
					if (ed == null) return;
					activateAsideFile(file);
				} catch (e) { log("open in aside failed:", e); }
			}
		});
		// Sit next to "Show in tree" instead of at the bottom of a long menu.
		var menu = TM.menu;
		var at = -1;
		var items = menu.items;
		for (var i = 0; items != null && i < items.length; i++) {
			if (items[i] != null && items[i].id === "show-in-tree") { at = i; break; }
		}
		if (at >= 0 && typeof menu.insert === "function") menu.insert(at, TAB_MENU_ITEM);
		else menu.append(TAB_MENU_ITEM);
	}

	function hookTabMenu() {
		if (TAB_MENU_HOOKED || !enabled) return;
		var G2 = window.GMEdit;
		if (G2 == null || typeof G2.on !== "function") return;
		try {
			G2.on("tabMenu", function (e) {
				installTabMenuItem();
				if (TAB_MENU_ITEM == null) return;
				var file = e != null && e.target != null ? e.target.gmlFile : null;
				TAB_MENU_ITEM.enabled = file != null && file.codeEditor != null;
			});
			TAB_MENU_HOOKED = true;
		} catch (e) {
			log("tab menu hook failed:", e);
		}
	}

	// A closed file must not stay in the right pane's strip. The file the pane is currently
	// showing is left alone: the session outlives the tab, so removing it would only make
	// `ensureAsideTabs` push it straight back.
	function hookFileClose() {
		if (FILE_CLOSE_HOOKED || !enabled) return;
		var G2 = window.GMEdit;
		if (G2 == null || typeof G2.on !== "function") return;
		try {
			G2.on("fileClose", function (e) {
				var f = e != null ? e.file : null;
				if (f == null) return;
				var i = asideTabIndex(f);
				if (i < 0) return;
				if (f === currentAsideFile()) return;
				ASIDE_TABS.splice(i, 1);
				renderAsideTabs();
			});
			FILE_CLOSE_HOOKED = true;
		} catch (e) {
			log("fileClose hook failed:", e);
		}
	}

	// Closing the pane. `show-aside` keeps `hide()` in its closure - the object it hands to
	// `GMEdit.register` only carries `init`/`cleanup` - and `plugins_PluginManager.stop`
	// is not an option either (it marks the plugin uninitialised in the preferences and
	// the next start would add a second "Show aside" entry). The pane puts a `Hide aside`
	// item on its *own* context menu, and that item's `click` is `hide()`, so press it.
	// Rebuilding the DOM by hand is not a substitute: the plugin would keep `gmlFile`
	// set, and its `show()` bails out when `gmlFile == file` - the pane would never reopen.
	function hideAsidePane() {
		var ed = findAsideEditor();
		if (ed == null) return true;              // already closed
		try {
			var menu = ed.contextMenu != null ? ed.contextMenu.menu : null;
			var items = menu != null ? menu.items : null;
			for (var i = 0; items != null && i < items.length; i++) {
				var it = items[i];
				if (it != null && it.label === "Hide aside" && typeof it.click === "function") {
					it.click();
					break;
				}
			}
		} catch (e) {
			log("aside hide failed:", e);
		}
		return findAsideEditor() == null;
	}

	// The pane belongs to `show-aside`; its context-menu entry is the only public way to
	// open it, so press that button instead of duplicating its DOM work here.
	function ensureAsideOpen() {
		var ed = findAsideEditor();
		if (ed != null) return ed;
		try {
			var main = mainEditor();
			var menu = main != null && main.contextMenu != null ? main.contextMenu.menu : null;
			var items = menu != null ? menu.items : null;
			for (var i = 0; items != null && i < items.length; i++) {
				if (items[i] != null && items[i].id === "show-aside" && typeof items[i].click === "function") {
					items[i].click();
					break;
				}
			}
		} catch (e) { /* ignore */ }
		return findAsideEditor();
	}

	function syncAsideFocus() {
		if (!enabled || !OV_HOOKED) return;
		var ed = findAsideEditor();
		if (ed == null) {
			if (ASIDE_ACTIVE) unpinAside();
			ASIDE_EDITOR = null;
			try { ensureAsideTabs(null); } catch (e) { /* ignore */ }   // pane closed: forget its tabs
			return;
		}
		if (ASIDE_EDITOR !== ed) hookAsideEditor(ed);
		try { ensureAsideTabs(ed); } catch (e) { /* ignore */ }
		var box = asideContainer();
		var act = document.activeElement;
		var active = box != null && act != null && box.contains(act);
		if (active === ASIDE_ACTIVE) {
			if (active) ensurePinned();
			return;
		}
		ASIDE_ACTIVE = active;
		if (active) pinAside();
		else unpinAside();
	}

	function hookAsideEditor(ed) {
		ASIDE_EDITOR = ed;
		try { hookTabMenu(); } catch (e) { /* ignore */ }
		try { hookFileClose(); } catch (e) { /* ignore */ }
		try { ensureAsideTabs(ed); } catch (e) { /* ignore */ }
		if (ed == null || ed.__tmAsideHooked) return;
		ed.__tmAsideHooked = true;
		try {
			ed.on("focus", function () {
				ASIDE_ACTIVE = false;                 // force a re-pin through the same path
				window.setTimeout(syncAsideFocus, 0);
			});
			ed.on("changeSelection", function () {
				if (!enabled || !ASIDE_ACTIVE || EMIT_BUSY) return;
				// `outline-view` only listens on the main editor. Nudging it makes the
				// "you are here" highlight follow this pane; updateGml then reads the
				// aside document instead of the left one.
				EMIT_BUSY = true;
				try {
					var main = mainEditor();
					if (main != null && typeof main._emit === "function") main._emit("changeSelection");
				} catch (e) { /* ignore */ }
				finally { EMIT_BUSY = false; }
			});
			ed.on("changeSession", function (e) {
				ASIDE_DIRTY = true;
				var s = e && e.session;
				if (s != null && typeof s.on === "function") {
					s.on("change", function () { ASIDE_DIRTY = true; });
				}
				try { addAsideTab(currentAsideFile(ed)); renderAsideTabs(); } catch (e2) { /* ignore */ }
				window.setTimeout(syncAsideFocus, 0);
			});
		} catch (e) { log("aside hook failed:", e); }
		try {
			if (ed.session != null && typeof ed.session.on === "function") {
				ed.session.on("change", function () { ASIDE_DIRTY = true; });
			}
		} catch (e) { /* ignore */ }
		log("aside pane hooked: the outline follows the focused pane");
	}

	function watchAside() {
		if (ASIDE_WATCH != null) return;
		ASIDE_WATCH = window.setInterval(syncAsideFocus, 700);
		try { hookTabMenu(); } catch (e) { /* ignore */ }
		try { hookFileClose(); } catch (e) { /* ignore */ }
		try {
			var main = mainEditor();
			if (main != null && typeof main.on === "function") {
				main.on("focus", function () {
					if (ASIDE_ACTIVE) unpinAside();
				});
			}
		} catch (e) { /* ignore */ }
	}

	// Which document/row should the outline read? Normally the file's own editor, but the
	// aside pane wins while it owns the focus (its session is a clone, so `file.codeEditor`
	// would walk the left pane's caret).
	function paneDocRow(file) {
		if (file != null && file.__tmAside) {
			var s1 = file.codeEditor != null ? file.codeEditor.session : null;
			if (s1 != null) return { doc: s1.doc, row: s1.selection.lead.row };
		}
		if (ASIDE_ACTIVE) {
			var ed = findAsideEditor();
			if (ed != null && ed.session != null) {
				return { doc: ed.session.doc, row: ed.session.selection.lead.row };
			}
		}
		return null;
	}

	function install(editor) {
		try { hookMiddleClick(); } catch (e) { /* ignore */ }
		try { hookOutlineView(); } catch (e) { /* ignore */ }
		var gc = editor && editor.gmlCompleters;
		if (!gc || gc.__tmPatched) return;
		gc.__tmPatched = true;
		var keys = ["smartCompleter", "smartAltCompleter"];
		for (var i = 0; i < keys.length; i++) {
			var c = gc[keys[i]];
			if (!c || c.__tmWrapped) continue;
			c.__tmWrapped = true;
			(function (completer, isAlt) {
				var orig = completer.getCompletions;
				completer.getCompletions = function (ed, session, pos, prefix, callback) {
					if (!enabled) return orig.apply(this, arguments);
					if (needsInjection(session)) {
						try { applyTo(session, pos.row); } catch (e) { log("apply failed:", e); }
					}
					var args = Array.prototype.slice.call(arguments);
					var cb = args.length ? args[args.length - 1] : null;
					if (typeof cb !== "function") return orig.apply(this, args);
					args[args.length - 1] = function (err, items) {
						var nonEmpty = err == null && items != null && items.length > 0;
						if (isAlt) {
							// The primary completer already answered this request (either from the
							// per-import table or through the fallback below). Anything this one
							// adds would show up as a duplicate row in the popup.
							if (primaryAnswered(pos)) {
								if (!ALT_SUPPRESS_LOGGED) {
									ALT_SUPPRESS_LOGGED = true;
									log("alt completer muted (primary already listed these fields)");
								}
								cb(null, []);
								return;
							}
						} else if (nonEmpty) {
							notePrimary(pos, items.length);
						}
						if (!nonEmpty && err == null) {
							try {
								var extra = buildFallback(session, pos);
								if (extra != null && extra.length) {
									notePrimary(pos, extra.length);
									cb(null, extra);
									return;
								}
							} catch (e) { log("fallback failed:", e); }
						}
						cb(err, items);
					};
					return orig.apply(this, args);
				};
			})(c, keys[i] === "smartAltCompleter");
		}
	}

	// Catch every editor, including ones created before this plugin finished loading.
	function hookBind() {
		var C = G("ace.AceWrapCommonCompleters");
		if (!C || !C.prototype || C.prototype.__tmBindPatched) return;
		C.prototype.__tmBindPatched = true;
		var orig = C.prototype.bind;
		C.prototype.bind = function (editor) {
			var r = orig.apply(this, arguments);
			try { install(editor); } catch (e) { log("install failed:", e); }
			return r;
		};
	}

	// ---- "reload all open files" button in the project tree header --------------
	// GMEdit only re-checks the *focused* tab (`GmlFile.focus` -> `checkChanges`), and with
	// the stock preference (`fileChangeAction = 1`) every hit pops a dialog. When the
	// sources were rewritten by something else than GMEdit - another editor, a generator,
	// a build script - that means clicking through every tab and answering the same
	// question again and again.
	//
	// This puts one button next to the tree's burger that reloads every open tab from disk
	// in a single pass, with no dialog per file. It takes the same route GMEdit itself uses
	// on a confirmed reload (`EditCode.load` + `savePost_shared(..., true)`), so the file is
	// re-indexed and `file.time` is synced - the stale-buffer prompt then never fires for
	// those tabs afterwards.
	//
	// A tab with *unsaved* edits is left alone: "the file changed outside" and "I am about
	// to throw away typing" are different things, and only the first one is what the button
	// is for. Shift+click forces those too. Nothing is ever written to disk here.
	//
	// This one is deliberately *not* gated on the type-inference checkbox in Preferences:
	// it is a plain editor utility, and turning off inference should not take it away.
	// `cleanup` (plugin switched off entirely) is what removes it.
	var RELOAD_BTN = null;
	var DOT_EL = null;             // the green dot: a real child, inline-styled
	var RELOAD_SPIN_TIMER = 0;
	var TOAST_EL = null;
	var TOAST_TIMER = 0;
	// Green dot: "at least one open file differs from what the buffer holds". `-1` means
	// "not computed yet", so the first pass always writes the class/title.
	var RELOAD_COUNT = -1;
	var RELOAD_POLL = 0;
	var RELOAD_POLL_MS = 1500;
	var RELOAD_FOCUS_HOOKED = false;

	// Everything below "did it light up?" is unobservable from the outside, so this build
	// also reports itself to `plugins/gm-typemaster/diag.json`. `BUILD` is the first thing
	// to look at: if the file still says an older stamp, the plugin was never reloaded
	// (Ctrl+R reloads the *project*, not the plugin - the command palette's "Reload GMEdit"
	// or a restart is what re-reads main.js from disk).
	var BUILD = "dot-2026-10-25c";

	var RELOAD_TITLE = "Reload every open file from disk\n" +
		"Shift+click: also the tabs that have unsaved edits";

	// A plain "rotate right" icon, drawn with `currentColor`: the dark theme recolours the
	// stock buttons' svg children one by one and would not know about this one.
	var RELOAD_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" ' +
		'stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">' +
		'<polyline points="15.3 2.7 15.3 6.7 11.3 6.7"></polyline>' +
		'<path d="M13.66 10a6 6 0 1 1-1.41-6.24L15.3 6.7"></path></svg>';

	// Line endings and a trailing newline are not "a change" - on Windows every tool that
	// rewrites a file may flip CRLF, and reloading for that alone would drop the undo
	// history and the folds for nothing.
	function normCode(s) {
		if (s == null) return "";
		return String(s).replace(/\r/g, "").replace(/\s+$/, "");
	}

	function fileLabel(file) {
		if (file == null) return "?";
		if (file.name != null && file.name !== "") return file.name;
		return file.path || "?";
	}

	// Every file the main tab bar has open. `tabEl.gmlFile` is filled in by `ui.ChromeTabs`
	// when the tab is created; the welcome page has one too, with `path == null`, and
	// `reloadTabFile` drops it.
	function openTabFiles() {
		var out = [];
		var els = null;
		try { els = document.querySelectorAll("#tabs .chrome-tab"); } catch (e) { return out; }
		for (var i = 0; i < els.length; i++) {
			var f = els[i].gmlFile;
			if (f != null && out.indexOf(f) < 0) out.push(f);
		}
		return out;
	}

	// The aside pane can outlive its main tab (close the tab, the right pane keeps showing
	// it), and `show-aside` works on a clone that shares the *document* - so reloading that
	// file updates the pane as a side effect. Its `GmlFile` is no longer in the tab bar, so
	// it has to be collected separately.
	//
	// `gml.file.GmlFile.current` is added last as a safety net: `tabEl.gmlFile` is only
	// attached the first time a tab is activated, and a tab that has never been clicked has
	// no file attached to it at all. The file the user is looking at is the one that must
	// never be missed, and it is available without going through the DOM.
	function allOpenFiles() {
		var out = openTabFiles();
		for (var i = 0; i < ASIDE_TABS.length; i++) {
			var f = ASIDE_TABS[i];
			if (f != null && out.indexOf(f) < 0) out.push(f);
		}
		try {
			var cur = G("gml.file.GmlFile").current;
			if (cur != null && cur.path != null && out.indexOf(cur) < 0) out.push(cur);
		} catch (e) { /* no GMEdit class table: the tab list is all we have */ }
		return out;
	}

	// ---- "is this buffer stale?" ------------------------------------------------
	// NOT `mtime > file.time`. GMEdit's own test looks reasonable, but `file.time` is
	// rewritten on *every* focus (`GmlFile.focus` -> `checkChanges` -> `checkForChanges`)
	// before the user even answers the dialog - including when they answer "Keep current",
	// which leaves the buffer stale. On top of that GMEdit installs its own `window focus`
	// listener (app.js, right after `ui.ChromeTabs.init`) that runs `checkChanges` on the
	// current file, so by the time anything of ours runs the timestamp already says "seen".
	// Using it made the dot never light up for the tab the user was looking at.
	//
	// So we keep our own baseline: the bytes the buffer was known to match. A file counts
	// as changed when its text differs from that baseline. `mtime` stays on as a cheap
	// pre-filter, so a file is only read when something actually touched it.
	var DISK_BASE = Object.create(null);   // path -> { mtime, sig, prevSig, prevMtime }
	var CHANGE_HOOKED = false;

	// djb2-xor over the normalised text. Cheap, and the length is part of it, so a swap of
	// two characters cannot silently collide in practice.
	function textHash(s) {
		var h = 5381;
		for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(16) + ":" + s.length;
	}

	function sigOf(text) { return textHash(normCode(text)); }

	// `mtimeMs` of a path, or `0` if it cannot be read (gone, locked, no fs bridge). Same
	// three sources GMEdit itself goes through, tried in that order. The extra fallbacks
	// are not paranoia for its own sake: if this returns 0 for everything, the dot can
	// never light up, and that failure is completely silent - `DISK_STAT_FAIL` exists so
	// the diagnostic dump can say so instead.
	var DISK_STAT_FAIL = 0;
	var DISK_STAT_WARNED = false;

	function mtimeOf(path) {
		try {
			var FS = window.Electron_FS;
			if (FS != null && typeof FS.statSync === "function") {
				var st = FS.statSync(path);
				if (st != null && st.mtimeMs > 0) return st.mtimeMs;
			}
		} catch (e) { /* deleted / locked / bad path */ }
		try {
			var impl = G("electron._FileSystem.FileSystemImpl");
			if (impl != null && typeof impl.mtimeSync === "function") {
				var t1 = impl.mtimeSync(path);
				if (t1 != null && t1 > 0) return t1;
			}
		} catch (e2) { /* ignore */ }
		try {
			var wrap = G("electron.FileWrap");
			if (wrap != null && typeof wrap.mtimeSync === "function") {
				var t2 = wrap.mtimeSync(path);
				if (t2 != null && t2 > 0) return t2;
			}
		} catch (e3) { /* ignore */ }
		DISK_STAT_FAIL++;
		return 0;
	}

	// "The buffer holds these bytes now." Called on first sight, after our own reload, and
	// on GMEdit's `fileSave` / `fileReload` - the three moments the two sides are in sync.
	// Deliberately not tied to `file.codeEditor`: a tab whose editor has not been built yet
	// still has a path, and skipping it is how the dot silently never lights up.
	function noteDiskBaseline(file) {
		if (file == null || file.path == null) return;
		var text = null;
		try { text = file.readContent(); } catch (e) { delete DISK_BASE[file.path]; return; }
		if (typeof text !== "string") { delete DISK_BASE[file.path]; return; }
		DISK_BASE[file.path] = { mtime: mtimeOf(file.path), sig: sigOf(text), prevSig: null, prevMtime: 0 };
	}

	function fileChangedOnDisk(file) {
		if (file == null || file.path == null) return false;
		var path = file.path;
		var mtime = mtimeOf(path);
		if (!(mtime > 0)) return false;
		var base = DISK_BASE[path];
		if (base == null) { noteDiskBaseline(file); return false; }   // first sight: remember it
		if (base.mtime === mtime) return false;           // untouched since the last look
		var text = null;
		try { text = file.readContent(); } catch (e) { return false; }
		if (typeof text !== "string") return false;
		var sig = sigOf(text);
		if (sig === base.sig) {                           // touched, but the bytes are the same
			base.mtime = mtime;
			return false;
		}
		// Real change. Remember what the buffer *should* still hold: that is how a stale
		// copy left behind by "Keep current" is told apart from unsaved typing.
		if (base.prevSig == null) { base.prevSig = base.sig; base.prevMtime = base.mtime; }
		return true;
	}

	// The buffer is the previous on-disk version (the "Keep current" case): replacing it is
	// not throwing away typing, so it must not be treated as dirty.
	function bufferIsOldDisk(file, session) {
		if (file == null || file.path == null || session == null) return false;
		var base = DISK_BASE[file.path];
		if (base == null || base.prevSig == null) return false;
		try { return sigOf(session.getValue()) === base.prevSig; } catch (e) { return false; }
	}

	// GMEdit's own "the two sides agree again" moments - needed in the opposite direction
	// from `fileChangedOnDisk`. Answering "Reload file" in its conflict dialog rewrites
	// `file.code` and fires `fileReload`, but nothing of ours would notice: the baseline
	// would still hold the old bytes and the dot would stay lit on a tab that is already
	// up to date. `fileSave` is the same story after a save.
	function onDiskSynced(ev) {
		try {
			var f = (ev != null) ? ev.file : null;
			if (f != null) noteDiskBaseline(f);
		} catch (e) { /* ignore */ }
	}

	function hookDiskSignals() {
		if (CHANGE_HOOKED) return;
		try {
			var api = window.GMEdit;
			if (api == null || typeof api.on !== "function") return;
			api.on("fileSave", onDiskSynced);
			api.on("fileReload", onDiskSynced);
			CHANGE_HOOKED = true;
		} catch (e) { log("could not listen for fileSave/fileReload:", e); }
	}

	// `cleanup` has to do this by hand: GMEdit does not detach plugin listeners itself, so
	// a stopped-and-restarted plugin would otherwise stack a second copy of the handler.
	function unhookDiskSignals() {
		if (!CHANGE_HOOKED) return;
		CHANGE_HOOKED = false;
		try {
			var api = window.GMEdit;
			if (api != null && typeof api.off === "function") {
				api.off("fileSave", onDiskSynced);
				api.off("fileReload", onDiskSynced);
			}
		} catch (e) { /* ignore */ }
	}

	// Recount and update the badge. Only touches the DOM when the number actually changed,
	// because this runs on a timer. The class is also compared, not just the counter: that
	// keeps the badge honest if anything else ever removes it.
	function refreshChangedBadge() {
		var n = 0;
		var total = 0;
		DISK_STAT_FAIL = 0;
		try {
			var files = allOpenFiles();
			total = files.length;
			for (var i = 0; i < files.length; i++) {
				// One file whose reader throws must not zero the count for every other tab,
				// which is exactly what a bare loop + one outer `catch` does.
				try {
					if (fileChangedOnDisk(files[i])) n++;
				} catch (e1) { DIAG_LAST_ERROR = "check " + errText(fileLabel(files[i])) + ": " + errText(e1); }
			}
		} catch (e) {
			n = 0;
			DIAG_LAST_ERROR = "refreshChangedBadge: " + errText(e);
		}
		// Every single file came back unreadable: the change signal is dead, not quiet.
		// Said once, so a "the dot never shows up" report can be answered from the log.
		if (total > 0 && DISK_STAT_FAIL >= total && !DISK_STAT_WARNED) {
			DISK_STAT_WARNED = true;
			log("change detection: could not read mtime of any open file - " +
				"the green dot cannot work. Electron_FS.statSync may be unavailable.");
		}
		RELOAD_COUNT = n;
		// `applyBadge` re-reads the class instead of trusting the previous count: it is
		// cheap, and it heals the case where something else removed it between two passes.
		applyBadge(n);
		writeDiag(false, n);
		return n;
	}

	// The dot has two independent ways of being drawn - inline style, and a class the
	// stylesheet can see - because "the class is set but nothing appears" is otherwise
	// indistinguishable from "the class was never set" in a bug report.
	function applyBadge(n) {
		var want = n > 0;
		if (DOT_EL != null) {
			try { if (DOT_EL.style != null) DOT_EL.style.display = want ? "block" : "none"; } catch (e) { /* ignore */ }
			try {
				if (want) DOT_EL.classList.add("tm-dot-on");
				else DOT_EL.classList.remove("tm-dot-on");
			} catch (e1) { /* ignore */ }
		}
		if (RELOAD_BTN == null || RELOAD_BTN.parentNode == null) return;
		var on = false;
		try { on = RELOAD_BTN.classList.contains("tm-has-changes"); } catch (e2) { on = false; }
		if (on === want) return;
		try {
			if (want) RELOAD_BTN.classList.add("tm-has-changes");
			else RELOAD_BTN.classList.remove("tm-has-changes");
			RELOAD_BTN.title = (want
				? n + (n === 1 ? " open file has changed on disk\n" : " open files have changed on disk\n")
				: "") + RELOAD_TITLE;
		} catch (e3) { /* ignore */ }
	}

	// ---- self-report -----------------------------------------------------------
	// Every gate in this path fails silently by design (a stat that throws, a tab whose
	// `tabEl.gmlFile` was never attached, a poll that never started, a stylesheet that
	// did not load). Rather than ask for a devtools screenshot, the plugin writes what it
	// sees next to itself: `plugins/gm-typemaster/diag.json`.
	var DIAG_LAST = "";
	var DIAG_AT = 0;
	var DIAG_PATH = null;
	var DIAG_LAST_ERROR = null;

	function errText(e) {
		try {
			if (e == null) return "null";
			if (e.message != null) return String(e.message);
			return String(e);
		} catch (e2) { return "?"; }
	}

	function diagPath() {
		// `""` is the cached "unavailable" answer, so a missing `electron.FileWrap` is not
		// resolved (and thrown through) again on every pass.
		if (DIAG_PATH != null) return DIAG_PATH === "" ? null : DIAG_PATH;
		try {
			var wrap = G("electron.FileWrap");
			var base = wrap != null ? wrap.userPath : null;
			if (base == null) { DIAG_PATH = ""; return null; }
			DIAG_PATH = String(base).replace(/[\\\/]+$/, "") + "/plugins/gm-typemaster/diag.json";
		} catch (e) { DIAG_PATH = ""; return null; }
		return DIAG_PATH;
	}

	// Per-file detail. Deliberately recomputes from scratch instead of reusing whatever
	// the last pass cached: this is what someone reads when the dot is *not* lighting up.
	function diagSnapshot(n) {
		var out = {
			build: BUILD,
			at: new Date().toISOString(),
			dotVisible: DOT_EL != null && DOT_EL.style != null
				? (DOT_EL.style.display === "block") : null,
			dotInDom: DOT_EL != null && DOT_EL.parentNode != null,
			buttonInDom: RELOAD_BTN != null && RELOAD_BTN.parentNode != null,
			buttonHasClass: false,
			pollRunning: RELOAD_POLL !== 0,
			signalsHooked: CHANGE_HOOKED,
			windowHidden: !!document.hidden,
			windowFocused: typeof document.hasFocus === "function" ? document.hasFocus() : null,
			openFiles: 0,
			changed: n,
			lastError: DIAG_LAST_ERROR,
			files: []
		};
		try { out.buttonHasClass = RELOAD_BTN != null && RELOAD_BTN.classList.contains("tm-has-changes"); }
		catch (e) { /* ignore */ }
		var files = [];
		try { files = allOpenFiles(); } catch (e1) { out.lastError = "allOpenFiles: " + errText(e1); }
		for (var i = 0; i < files.length; i++) {
			var f = files[i];
			var row = { name: errText(fileLabel(f)) };
			try {
				row.path = f.path;
				row.hasCodeEditor = f.codeEditor != null;
				row.hasSession = f.codeEditor != null && f.codeEditor.session != null;
				row.mtime = mtimeOf(f.path);
				var b = f.path != null ? DISK_BASE[f.path] : null;
				row.baseMtime = b != null ? b.mtime : null;
				row.baseSig = b != null ? b.sig : null;
				row.hasPrevSig = b != null && b.prevSig != null;
				try {
					row.bufferSig = row.hasSession ? sigOf(f.codeEditor.session.getValue()) : null;
				} catch (e2) { row.bufferSig = "err:" + errText(e2); }
				var text = null;
				try { text = f.readContent(); } catch (e3) { row.readError = errText(e3); }
				if (typeof text === "string") row.diskSig = sigOf(text);
				row.changed = fileChangedOnDisk(f);
			} catch (e4) { row.error = errText(e4); }
			out.files.push(row);
		}
		out.openFiles = out.files.length;
		return out;
	}

	// The tab count is not passed in: the snapshot counts them itself, so a stale caller
	// cannot make the file disagree with its own `files`.
	function writeDiag(force, n) {
		try {
			var path = diagPath();
			if (path == null) { DIAG_LAST_ERROR = "no diag path (electron.FileWrap.userPath?)"; return null; }
			var FS = window.Electron_FS;
			if (FS == null || typeof FS.writeFileSync !== "function") {
				DIAG_LAST_ERROR = "no Electron_FS.writeFileSync";
				return null;
			}
			var snap = diagSnapshot(n == null ? RELOAD_COUNT : n);
			var key = snap.build + "|" + snap.changed + "|" + snap.openFiles + "|" + snap.buttonHasClass +
				"|" + snap.dotVisible + "|" + snap.lastError;
			var now = Date.now();
			// Write on every change, plus a slow heartbeat so a stale file still means
			// "the plugin is alive and nothing changed" rather than "nothing wrote".
			if (!force && key === DIAG_LAST && now - DIAG_AT < 30000) return snap;
			DIAG_LAST = key;
			DIAG_AT = now;
			FS.writeFileSync(path, JSON.stringify(snap, null, 1), "utf8");
			DIAG_LAST_ERROR = null;         // a successful write clears the previous failure
			snap.lastError = null;
			return snap;
		} catch (e) {
			DIAG_LAST_ERROR = "writeDiag: " + errText(e);
			return null;
		}
	}

	// Polling, not file watching: `fs.watch` on a GMS project means one watcher per file and
	// a flood of events while the IDE rewrites things, for a signal that only has to be
	// roughly immediate. `statSync` x (number of open tabs) every 1.5s is nothing.
	//
	// Deliberately NOT gated on `document.hasFocus()`: Electron reports false for that
	// while a devtools window or an OS dialog has the focus, and a poll that silently stops
	// is exactly the failure mode this had. `document.hidden` (minimised / fully covered)
	// is the only case worth skipping, and `focus` still runs a catch-up pass.
	function startChangePoll() {
		if (!RELOAD_POLL) {
			try {
				RELOAD_POLL = window.setInterval(function () {
					try {
						if (document.hidden) return;
						refreshChangedBadge();
					} catch (e) { DIAG_LAST_ERROR = "poll: " + errText(e); }
				}, RELOAD_POLL_MS);
			} catch (e2) { RELOAD_POLL = 0; DIAG_LAST_ERROR = "setInterval: " + errText(e2); }
		}
		if (!RELOAD_FOCUS_HOOKED) {
			RELOAD_FOCUS_HOOKED = true;
			try {
				window.addEventListener("focus", function () {
					try { refreshChangedBadge(); } catch (e3) { DIAG_LAST_ERROR = "focus: " + errText(e3); }
				});
			} catch (e4) { /* ignore */ }
		}
		// First heartbeat right away, so diag.json exists even if nothing ever changes.
		try { writeDiag(true, RELOAD_COUNT); } catch (e5) { /* ignore */ }
	}

	// `"reloaded" | "same" | "dirty" | "missing" | "other" | "skip"`
	function reloadTabFile(file, force) {
		if (file == null || file.path == null) return "skip";
		var ed = file.codeEditor;
		var session = ed != null ? ed.session : null;
		if (session == null) {
			// Sprite / font / object tabs: their own `checkChanges` reloads silently - it is
			// only `EditCode.checkChanges` that ever asks a question.
			try { if (typeof file.checkChanges === "function") file.checkChanges(); } catch (e) { return "skip"; }
			return "other";
		}
		// `__changed` is GMEdit's own "buffer differs from disk" flag (driven by the undo
		// manager's clean state); the text comparison is the fallback for tabs that were
		// never focused since they were edited.
		var dirty = file.__changed === true;
		if (!dirty) {
			try { dirty = normCode(session.getValue()) !== normCode(file.code); } catch (e1) { dirty = false; }
		}
		// Answering "Keep current" in GMEdit's conflict dialog leaves the buffer on the
		// *previous* disk version while `file.code` already holds the new one - so it looks
		// dirty though nothing of the user's would be lost. Those tabs are what the button
		// is for: recognise the old bytes and let them through. Real typing is not a known
		// disk version, so it still stops here.
		if (dirty && !force && !bufferIsOldDisk(file, session)) return "dirty";
		var disk = null;
		try { disk = file.readContent(); } catch (e2) { return "missing"; }
		if (typeof disk !== "string") return "missing";
		var before = file.code;
		try { ed.load(disk); }                         // sets `file.code` and `file.time`
		catch (e3) { log("reload: could not load " + fileLabel(file), e3); return "skip"; }
		// Both sides go through `normCode` because the kind may post-process the text
		// (import stripping) - comparing raw disk bytes against it would always differ.
		if (!dirty && normCode(file.code) === normCode(before)) {
			// Nothing to replace, but the bytes on disk *did* move (a CRLF flip, or imports
			// the kind strips). The baseline has to follow anyway, otherwise the dot would
			// stay lit on a tab that is already current.
			noteDiskBaseline(file);
			return "same";
		}
		var pos = null, top = 0;
		try { pos = session.getCursorPosition(); top = session.getScrollTop() || 0; } catch (e4) { pos = null; }
		try {
			if (session.getValue() !== file.code) session.setValue(file.code);
		} catch (e5) {
			log("reload: could not replace the buffer of " + fileLabel(file), e5);
			return "skip";
		}
		if (pos != null) {
			// `setValue` throws the caret at 0:0 and scrolls to the top; on a reload the user
			// is usually looking at something specific, so put it back (clamped, the file
			// may have become shorter).
			try {
				var last = session.getLength() - 1;
				var row = pos.row | 0;
				if (row > last) row = last;
				if (row < 0) row = 0;
				session.getSelection().moveCursorToPosition({ row: row, column: pos.column });
				session.setScrollTop(top);
			} catch (e6) { /* cosmetic only */ }
		}
		try { file.savePost_shared(disk, true); }      // re-index, same as a confirmed reload
		catch (e7) { log("reload: reindex of " + fileLabel(file) + " failed", e7); }
		// The buffer and the file now agree, so the tab must not keep its "modified" dot.
		try { file.markClean(); } catch (e8) { /* ignore */ }
		// ...and neither should the button: this tab is in sync from here on.
		noteDiskBaseline(file);
		return "reloaded";
	}

	function doReloadAll(force) {
		var files = allOpenFiles();
		var nReload = 0, nSame = 0, nDirty = 0, nMissing = 0;
		for (var i = 0; i < files.length; i++) {
			var r;
			try { r = reloadTabFile(files[i], force); }
			catch (e) { r = "skip"; log("reload: " + fileLabel(files[i]) + " failed", e); }
			if (r === "reloaded") nReload++;
			else if (r === "same" || r === "other") nSame++;
			else if (r === "dirty") nDirty++;
			else if (r === "missing") nMissing++;
		}
		var msg = nReload === 0 ? "No open file changed on disk"
			: "Reloaded " + nReload + (nReload === 1 ? " file" : " files");
		if (nDirty > 0) msg += "  ·  " + nDirty + " kept: unsaved edits (Shift+click forces)";
		if (nMissing > 0) msg += "  ·  " + nMissing + " missing on disk";
		spinReloadButton();
		showToast(msg);
		// Tabs that were reloaded now match their file, so the dot goes away. Anything that
		// was skipped (`dirty`, `missing`) keeps it on - the toast says why.
		try { refreshChangedBadge(); } catch (e) { /* ignore */ }
		log("reload-all (" + (force ? "force" : "safe") + "): " + nReload + " reloaded, " +
			nSame + " unchanged, " + nDirty + " skipped, " + nMissing + " missing");
		return nReload;
	}

	function showToast(text) {
		if (text == null || text === "") return;
		try {
			if (TOAST_EL == null) {
				TOAST_EL = document.createElement("div");
				TOAST_EL.className = "tm-toast";
				document.body.appendChild(TOAST_EL);
			}
			if (TOAST_EL.parentNode == null) document.body.appendChild(TOAST_EL);
			TOAST_EL.textContent = text;
			TOAST_EL.classList.add("tm-toast-on");
			if (TOAST_TIMER) window.clearTimeout(TOAST_TIMER);
			TOAST_TIMER = window.setTimeout(function () {
				TOAST_TIMER = 0;
				try { if (TOAST_EL != null) TOAST_EL.classList.remove("tm-toast-on"); } catch (e) { /* ignore */ }
			}, 2600);
		} catch (e) { /* the log line in `doReloadAll` already says what happened */ }
	}

	function spinReloadButton() {
		if (RELOAD_BTN == null) return;
		try {
			RELOAD_BTN.classList.remove("tm-spin");
			// Reading a layout property forces a reflow, which is what makes the animation
			// start over when the button is clicked again before it finished.
			RELOAD_BTN.offsetWidth;
			RELOAD_BTN.classList.add("tm-spin");
		} catch (e) { /* ignore */ }
		if (RELOAD_SPIN_TIMER) window.clearTimeout(RELOAD_SPIN_TIMER);
		RELOAD_SPIN_TIMER = window.setTimeout(function () {
			RELOAD_SPIN_TIMER = 0;
			try { if (RELOAD_BTN != null) RELOAD_BTN.classList.remove("tm-spin"); } catch (e2) { /* ignore */ }
		}, 520);
	}

	function onReloadAllClick(e) {
		try {
			if (e != null) {
				e.preventDefault();
				e.stopPropagation();
			}
			doReloadAll(e != null && e.shiftKey === true);
		} catch (err) {
			log("reload-all button failed:", err);
		}
	}

	// `#tree-td > .chrome-tabs.project-name > .system-buttons` - the row that already holds
	// the burger. Inserting before it keeps the burger rightmost, which is what the eye
	// expects; the CSS shrinks `#project-name` by one more slot so the two never overlap.
	function treeHeaderButtons() {
		try { return document.querySelector("#tree-td .chrome-tabs.project-name .system-buttons"); }
		catch (e) { return null; }
	}

	// The dot is a real element with inline geometry, not a `::after` rule. Two reasons:
	// the reload button should keep working even if `styles.css` is stale or a selector
	// stops matching, and "the class is set but nothing is drawn" is indistinguishable
	// from "the class was never set" when someone reports it.
	function makeDot() {
		var dot = null;
		try {
			dot = document.createElement("i");
			dot.className = "tm-dot";
			var css = "position:absolute;left:7px;top:4px;width:6px;height:6px;" +
				"border-radius:50%;background:#4cc764;box-shadow:0 0 0 1px rgba(0,0,0,.38);" +
				"pointer-events:none;display:none;z-index:2;";
			try { dot.setAttribute("style", css); } catch (e) { /* no attribute support */ }
			try { if (dot.style != null) dot.style.display = "none"; } catch (e1) { /* ignore */ }
		} catch (e2) { dot = null; }
		DOT_EL = dot;
		return dot;
	}

	function installReloadButton() {
		// Poll and signals first: the dot cannot work without them, and they are also what
		// feeds `diag.json`. The tree header may not exist yet on the first pass.
		hookDiskSignals();
		startChangePoll();
		var box = treeHeaderButtons();
		if (box == null) return;                       // tree panel not built (yet)
		if (RELOAD_BTN == null) {
			RELOAD_BTN = document.createElement("span");
			RELOAD_BTN.className = "system-button tm-reload-all";
			RELOAD_BTN.id = "tm-reload-all";
			RELOAD_BTN.title = RELOAD_TITLE;
			RELOAD_BTN.innerHTML = RELOAD_ICON;
			RELOAD_BTN.appendChild(makeDot());
			RELOAD_BTN.addEventListener("mousedown", function (e) { e.stopPropagation(); });
			RELOAD_BTN.addEventListener("click", onReloadAllClick);
		}
		if (RELOAD_BTN.parentNode !== box) {
			var prefs = box.querySelector(".system-button.preferences");
			if (prefs != null) box.insertBefore(RELOAD_BTN, prefs);
			else box.appendChild(RELOAD_BTN);
		}
		var head = box.parentNode;
		if (head != null && head.classList != null) head.classList.add("tm-has-reload");
		// The first pass also has to run when the button was re-attached: the class lives on
		// the element, so re-attaching is harmless, but the count may have moved on.
		try { refreshChangedBadge(); } catch (e) { /* ignore */ }
	}

	function removeReloadButton() {
		try {
			if (RELOAD_BTN != null && RELOAD_BTN.parentNode != null) {
				RELOAD_BTN.parentNode.removeChild(RELOAD_BTN);
			}
		} catch (e) { /* ignore */ }
		var head = null;
		try { head = document.querySelector("#tree-td .chrome-tabs.project-name.tm-has-reload"); } catch (e2) { head = null; }
		if (head != null && head.classList != null) head.classList.remove("tm-has-reload");
		if (TOAST_TIMER) { window.clearTimeout(TOAST_TIMER); TOAST_TIMER = 0; }
		if (RELOAD_SPIN_TIMER) { window.clearTimeout(RELOAD_SPIN_TIMER); RELOAD_SPIN_TIMER = 0; }
		if (RELOAD_POLL) {
			try { window.clearInterval(RELOAD_POLL); } catch (e3) { /* ignore */ }
			RELOAD_POLL = 0;
		}
		RELOAD_COUNT = -1;
		unhookDiskSignals();
		DISK_BASE = Object.create(null);
		DISK_STAT_FAIL = 0;
		DISK_STAT_WARNED = false;
		try {
			if (TOAST_EL != null && TOAST_EL.parentNode != null) TOAST_EL.parentNode.removeChild(TOAST_EL);
		} catch (e4) { /* ignore */ }
		TOAST_EL = null;
	}

	// "It did not light up" is the one report that cannot be answered from a screenshot,
	// so there is a command that recomputes, writes `diag.json` immediately and says the
	// headline in a toast.
	function diagNow() {
		var n = -1;
		try { n = refreshChangedBadge(); } catch (e) { DIAG_LAST_ERROR = "diagNow: " + errText(e); }
		var snap = writeDiag(true, n);
		var msg;
		if (snap == null) {
			msg = "diag failed: " + (DIAG_LAST_ERROR || "unknown");
		} else {
			msg = "diag.json · build " + snap.build + " · " + snap.openFiles + " tab(s), " +
				snap.changed + " changed, dot " + (snap.dotVisible ? "on" : "off");
			if (snap.lastError) msg += " · " + snap.lastError;
		}
		showToast(msg);
		try { log("diag", snap); } catch (e2) { /* ignore */ }
		return snap;
	}

	function installExisting() {
		try {
			var els = document.querySelectorAll("pre.ace_editor");
			for (var i = 0; i < els.length; i++) {
				var ed = els[i].aceEditor;
				if (ed) install(ed);
			}
		} catch (e) { /* ignore */ }
		// The tree header exists from the start, but installing it again here costs nothing
		// and heals the case where something rebuilt `#tree-td` after the first attempt.
		try { installReloadButton(); } catch (e2) { /* ignore */ }
	}

	function setLinterPrefs(on) {
		try {
			var P = window.Preferences;
			if (!P || !P.current) return;
			var lp = P.current.linterPrefs || (P.current.linterPrefs = {});
			var keys = ["specTypeVar", "specTypeStatic", "specTypeLet", "specTypeConst", "specTypeMisc", "specTypeInst"];
			var changed = false;
			for (var i = 0; i < keys.length; i++) {
				if (lp[keys[i]] !== on) { lp[keys[i]] = on; changed = true; }
			}
			if (changed && P.save) P.save();
			return changed;
		} catch (e) { log("prefs failed:", e); return false; }
	}

	function readPrefs() {
		try {
			var P = window.Preferences;
			if (!P || !P.current) return true;
			return P.current.gmTypeMaster !== false;
		} catch (e) { return true; }
	}

	var COMMANDS = [];

	function currentEditor() {
		try {
			var els = document.querySelectorAll("pre.ace_editor");
			for (var i = 0; i < els.length; i++) {
				if (els[i].aceEditor) return els[i].aceEditor;
			}
		} catch (e) { /* ignore */ }
		return null;
	}

	function dumpState() {
		var out = { enabled: enabled, analyzed: CACHE != null };
		out.indexReady = INDEX_READY;
		out.externalFunctions = Object.keys(EXTERNAL).length;
		out.globalsWithShape = Object.keys(GLOBALS).length;
		out.documentedFunctions = Object.keys(DOCS).length;
		out.documentedFields = Object.keys(FIELDS).length;
		out.funcDocHook = FUNCDOC_HOOKED;
		out.statusBarHook = SBAR_HOOKED;
		out.tooltipHook = VARDOC_HOOKED;
		out.definitions = Object.keys(DEFS).length;
		out.definitionSites = DEFS_COUNT;
		out.outlineExtended = OV_HOOKED;
		out.reloadAllButton = RELOAD_BTN != null && RELOAD_BTN.parentNode != null;
		out.openTabs = openTabFiles().length;
		out.changedOnDisk = RELOAD_COUNT;      // what the green dot is showing
		out.diskWatch = {
			build: BUILD,
			polling: RELOAD_POLL !== 0,
			baselines: Object.keys(DISK_BASE).length,
			signalsHooked: CHANGE_HOOKED,
			mtimeFailures: DISK_STAT_FAIL,     // >0 last pass: the dot cannot light up
			windowFocused: typeof document.hasFocus === "function" ? document.hasFocus() : null,
			windowHidden: !!document.hidden,
			dotInDom: DOT_EL != null && DOT_EL.parentNode != null,
			diagPath: diagPath(),
			lastError: DIAG_LAST_ERROR
		};
		out.aside = {
			detected: ASIDE_EDITOR != null,
			focused: ASIDE_ACTIVE,
			file: ASIDE_FILE != null ? ASIDE_FILE.name : null,
			base: ASIDE_FILE != null ? (ASIDE_FILE.__tmBase ? ASIDE_FILE.__tmBase.name : null) : null,
			sharedDoc: ASIDE_EDITOR != null && ASIDE_EDITOR.session != null &&
				mainEditor() != null && mainEditor().session != null &&
				ASIDE_EDITOR.session.doc === mainEditor().session.doc,
			tabs: ASIDE_TABS.length,
			tabsShown: ASIDE_TABS_EL != null && ASIDE_TABS_EL.parentElement != null,
			tabMenu: TAB_MENU_ITEM != null,
			dirty: ASIDE_DIRTY,
			reusedTree: ASIDE_REUSED
		};
		try {
			var ed = currentEditor();
			if (ed == null) { out.editor = "none"; log("dump", out); return out; }
			var session = ed.session;
			var pos = ed.getCursorPosition();
			var scope = session.gmlScopes ? session.gmlScopes.get(pos.row) : null;
			out.scope = scope;
			out.patched = !!(ed.gmlCompleters && ed.gmlCompleters.__tmPatched);
			var imp = scope != null && session.gmlEditor ? session.gmlEditor.imports[scope] : null;
			out.importExists = imp != null;
			if (imp != null) {
				var names = [];
				for (var k in imp.localTypes) {
					var tn = null;
					try { tn = G("gml.type.GmlTypeTools").getNamespace(imp.localTypes[k]); } catch (e) { /* ignore */ }
					names.push(k + " -> " + tn);
				}
				out.localTypes = names;
				out.importNamespaces = Object.keys(imp.namespaces || {});
			}
			var data = getData(session);
			if (data != null) {
				out.structs = data.structs.length;
				out.vars = [];
				for (var vi = 0; vi < data.vars.length; vi++) {
					var v = data.vars[vi];
					out.vars.push(v.name + "@" + (v.row + 1) + " -> " + typeNameOf(v.type));
				}
				out.globals = [];
				var gl = data.globals || {};
				for (var gn2 in gl) out.globals.push(gn2 + " -> " + typeNameOf(gl[gn2]));
			}
		} catch (e) {
			out.error = String(e);
		}
		log("dump", out);
		return out;
	}

	// Everything that decides whether a middle click can be handled, in one object. Also
	// exposed as `__typeMaster.diag()`, so a "it opened the manual again" report can be
	// answered from the console instead of from guesswork.
	function diagState(name) {
		var out = {
			enabled: enabled,
			captureHooked: MID_HOOKED,
			openDeclarationHooked: (function () {
				try {
					var OD = G("ui.OpenDeclaration");
					return !!(OD && OD.__tmHooked);
				} catch (e) { return false; }
			})(),
			indexReady: INDEX_READY,
			indexBuilding: INDEX_BUILDING,
			projectRoot: projectRoot(),
			eventMapEntries: (function () {
				try { return Object.keys(eventNameMap()).length; } catch (e) { return -1; }
			})(),
			definitions: Object.keys(DEFS).length,
			definitionSites: DEFS_COUNT,
			functionTypes: Object.keys(EXTERNAL).length,
			globalShapes: Object.keys(GLOBALS).length,
			helpURL: (function () {
				try { return G("gml.GmlAPI").helpURL; } catch (e) { return null; }
			})()
		};
		if (name != null) {
			out.lookup = name;
			out.found = !!(DEFS[name] && DEFS[name].length);
			out.sites = DEFS[name] || [];
			try { out.isKnownToEditor = isKnownToEditor(name); } catch (e) { out.isKnownToEditor = "error"; }
		}
		log("diag", out);
		return out;
	}

	function addCommands() {
		var defs = [{
			id: "typeMasterRefresh",
			label: "TypeMaster: Refresh inferred types",
			exec: function () {
				CACHE = null;
				OBJECTS = null;
				INDEX_READY = false;
				EVENT_MAP = null;
				EVENT_RETRY = 0;
				buildProjectIndex();
				log("cache cleared, types will be recomputed on the next completion");
			}
		}, {
			id: "typeMasterReloadAll",
			label: "TypeMaster: Reload all open files from disk",
			exec: function () { doReloadAll(false); }
		}, {
			id: "typeMasterDiagDot",
			label: "TypeMaster: Check the green dot (writes diag.json)",
			exec: function () { diagNow(); }
		}, {
			id: "typeMasterDump",
			label: "TypeMaster: Debug dump (console)",
			exec: function () { dumpState(); }
		}];
		for (var i = 0; i < defs.length; i++) {
			try {
				var cmd = { name: defs[i].id, exec: defs[i].exec };
				var item = { name: defs[i].label, exec: defs[i].id, title: "" };
				AceCommands.add(cmd);
				AceCommands.addToPalette(item);
				COMMANDS.push({ cmd: cmd, item: item });
			} catch (e) {
				log("could not register command:", defs[i].id, e);
			}
		}
	}

	function removeCommands() {
		for (var i = 0; i < COMMANDS.length; i++) {
			try { AceCommands.remove(COMMANDS[i].cmd); } catch (e) { /* ignore */ }
			try { AceCommands.removeFromPalette(COMMANDS[i].item); } catch (e) { /* ignore */ }
		}
		COMMANDS.length = 0;
	}

	GMEdit.register("gm-typemaster", {
		init: function () {
			enabled = readPrefs();
			// Each hook touches a different GMEdit internal, so they are isolated: on a GMEdit
			// build where one of them was renamed, the rest keeps working and the log names the
			// step that failed.
			var steps = [
				["commands", addCommands],
				["completion", hookBind],
				["middle-click", hookMiddleClick],
				["open-declaration", hookOpenDeclaration],
				["outline", hookOutlineView],
				["func-docs", hookFuncDoc],
				["status-bar", hookStatusBar],
				["tooltips", hookTooltips],
				["split-view", watchAside],
				["reload-all-button", installReloadButton],
				["existing-editors", installExisting]
			];
			for (var si = 0; si < steps.length; si++) {
				try { steps[si][1](); }
				catch (e) { log("init step '" + steps[si][0] + "' failed (rest continues):", e); }
			}
			try { window.__typeMaster = { dump: dumpState, diag: diagState, dot: diagNow }; } catch (e) { /* ignore */ }
			window.setTimeout(installExisting, 1500);
			window.setTimeout(installExisting, 4000);
			window.setTimeout(function () {
				try { buildProjectIndex(); } catch (e) { log("index failed:", e); }
			}, 800);

			if (enabled) {
				var changed = setLinterPrefs(true);
				if (changed) log("enabled GMEdit's built-in implicit type inference");
			}
			log("ready (enabled=" + enabled + ", build=" + BUILD + ")");
		},
		cleanup: function () {
			enabled = false;
			removeCommands();
			removeReloadButton();
		},
		buildPreferences: function (out) {
			try {
				var P = window.Preferences;
				var cb = P.addCheckbox(out, "Infer struct fields and return types (TypeMaster)",
					P.current.gmTypeMaster !== false,
					function (v) {
						P.current.gmTypeMaster = v;
						enabled = v;
						CACHE = null;
						P.save();
					});
				cb.title = "Scans the current file for struct literals and function return values\n" +
					"so that `obj.` lists their fields without manual type annotations.\n" +
					"Changes take effect on the next completion.";

				var cb2 = P.addCheckbox(out, "Also enable GMEdit's built-in implicit types",
					(P.current.linterPrefs || {}).specTypeVar === true,
					function (v) {
						setLinterPrefs(v);
						log(v ? "built-in implicit types enabled" : "built-in implicit types disabled");
					});
				cb2.title = "Sets Preferences > Linter > Implicit types (var/static/let/const/instance).\n" +
					"GMEdit needs a project reload (Ctrl+R) to apply these.";
			} catch (e) { log("preferences UI failed:", e); }
		}
	});
})();
