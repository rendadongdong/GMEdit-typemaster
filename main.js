// gm-typemaster / main.js
// Wires TypeMasterAnalyzer into GMEdit: inferred types are injected into the editor's own
// type tables, so the native completion popup lists struct fields without any annotations.
(function () {
	"use strict";

	var NS_PREFIX = "$tm.";
	var REBUILD_MS = 400;

	var CACHE = null;
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
			INDEX_READY = true;
			INDEX_TIME = Date.now();
			CACHE = null;
			log("project index: " + files.length + " file(s), " +
				Object.keys(out).length + " function(s) with a return type, " +
				Object.keys(gout).length + " global(s) with a known shape, " +
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

	function getData(session) {
		var now = Date.now();
		if (CACHE && CACHE.session === session && now - CACHE.time < REBUILD_MS) return CACHE.data;
		var data;
		ensureProjectIndex();
		try {
			data = TypeMasterAnalyzer.analyze(session.getValue(), {
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
		data.__gen = ++GEN;
		CACHE = { session: session, time: now, data: data };
		return data;
	}

	function applyTo(session, row) {
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
			if (!tn) continue;
			ensureForType(v.type);

			var scope = null;
			try { scope = scopes ? scopes.get(v.row) : null; } catch (e) { scope = null; }
			if (scope == null) continue;

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
		log("fallback supplied " + out.length + " field(s) for `" + expr + ".`");
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
	function braceDepthByLine(text, n) {
		var out = new Array(n);
		var masked = text;
		try { masked = TypeMasterAnalyzer.mask(text); } catch (e) { /* use raw */ }
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
		var depth = braceDepthByLine(rows.join("\n"), n);
		var showArgs = ovPref("showFuncArgs", true);
		var showAtTop = ovPref("showAtTop", true);
		var def = null;                     // enclosing #event / #define / function
		var defIsEvent = false;             // an #event section owns everything until the next one
		for (var row = 0; row < n; row++) {
			var line = rows[row], mt, label, title, nav, tail;
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
	// the "you are here" highlight lands on them too.
	function updateGml(file, pos) {
		var def = pos.def, row = pos.row;
		var ctxName = null, ctxRow = null;
		var doc = file.codeEditor.session.doc;
		for (; row >= 0; row--) {
			var text = doc.getLine(row), mt;
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
		pos.row = ctxRow != null ? ctxRow : row;
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
					try { applyTo(session, pos.row); } catch (e) { log("apply failed:", e); }
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

	function installExisting() {
		try {
			var els = document.querySelectorAll("pre.ace_editor");
			for (var i = 0; i < els.length; i++) {
				var ed = els[i].aceEditor;
				if (ed) install(ed);
			}
		} catch (e) { /* ignore */ }
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
		out.definitions = Object.keys(DEFS).length;
		out.definitionSites = DEFS_COUNT;
		out.outlineExtended = OV_HOOKED;
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
				["existing-editors", installExisting]
			];
			for (var si = 0; si < steps.length; si++) {
				try { steps[si][1](); }
				catch (e) { log("init step '" + steps[si][0] + "' failed (rest continues):", e); }
			}
			try { window.__typeMaster = { dump: dumpState, diag: diagState }; } catch (e) { /* ignore */ }
			window.setTimeout(installExisting, 1500);
			window.setTimeout(installExisting, 4000);
			window.setTimeout(function () {
				try { buildProjectIndex(); } catch (e) { log("index failed:", e); }
			}, 800);

			if (enabled) {
				var changed = setLinterPrefs(true);
				if (changed) log("enabled GMEdit's built-in implicit type inference");
			}
			log("ready (enabled=" + enabled + ")");
		},
		cleanup: function () {
			enabled = false;
			removeCommands();
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
