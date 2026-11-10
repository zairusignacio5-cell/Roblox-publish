"use strict";
/* Delete a script / item (and everything inside it) from the in-memory place. */
const core = (function () {
  const module = { exports: {} }; const exports = module.exports;

/* Per-property-type layout engine for binary .rbxl PROP chunk bodies.
   A body is described as segments; every layout is validated against the exact
   byte length, so anything unexpected fails closed instead of corrupting a file. */

const SEG = {
  0x01: [{ k: "str" }],
  0x02: [{ k: "col", w: 1 }],
  0x03: [{ k: "col", w: 4 }], 0x04: [{ k: "col", w: 4 }], 0x12: [{ k: "col", w: 4 }],
  0x1c: [{ k: "col", w: 4 }], 0x0b: [{ k: "col", w: 4 }],
  0x1f: [{ k: "col", w: 16 }], 0x21: [{ k: "col", w: 8 }], 0x1b: [{ k: "col", w: 8 }],
  0x05: [{ k: "plain", w: 8 }], 0x17: [{ k: "plain", w: 8 }],
  0x06: [{ k: "col", w: 4 }, { k: "col", w: 4 }],
  0x07: [{ k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }],
  0x18: [{ k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }],
  0x0c: [{ k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }],
  0x0d: [{ k: "col", w: 4 }, { k: "col", w: 4 }],
  0x0e: [{ k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }],
  0x1a: [{ k: "col", w: 1 }, { k: "col", w: 1 }, { k: "col", w: 1 }],
  0x13: [{ k: "ref" }],
  0x10: [{ k: "var", f: "rot" }, { k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }],
  0x1e: [{ k: "lit", v: [0x10] }, { k: "var", f: "rot" }, { k: "col", w: 4 }, { k: "col", w: 4 }, { k: "col", w: 4 }, { k: "lit", v: [0x02] }, { k: "col", w: 1 }],
  0x15: [{ k: "var", f: "numseq" }],
  0x16: [{ k: "var", f: "colseq" }],
  0x19: [{ k: "var", f: "phys" }],
  0x20: [{ k: "var", f: "font" }],
  0x22: [{ k: "content" }],
};

const WALK = {
  str: (b, o) => 4 + b.readUInt32LE(o),
  rot: (b, o) => (b[o] === 0 ? 37 : 1),
  numseq: (b, o) => 4 + 12 * b.readUInt32LE(o),
  colseq: (b, o) => 4 + 20 * b.readUInt32LE(o),
  phys: (b, o) => { if (b[o] === 0 || b[o] === 2) return 1; if (b[o] === 1) return 21; if (b[o] === 3) return 25; throw new Error("phys"); },
  font: (b, o) => { let p = o; p += 4 + b.readUInt32LE(p); p += 3; p += 4 + b.readUInt32LE(p); return p - o; },
};

function layout(type, body, n) {
  const defs = type === 0x01 ? [{ k: "var", f: "str" }] : SEG[type];
  if (!defs) return null;
  const segs = [];
  let p = 0;
  try {
    for (const d of defs) {
      if (d.k === "col") { segs.push({ k: "col", w: d.w, off: p }); p += d.w * n; }
      else if (d.k === "plain") { segs.push({ k: "plain", w: d.w, off: p }); p += d.w * n; }
      else if (d.k === "ref") { segs.push({ k: "ref", off: p }); p += 4 * n; }
      else if (d.k === "lit") { for (let i = 0; i < d.v.length; i++) if (body[p + i] !== d.v[i]) return null; segs.push({ k: "lit", v: d.v }); p += d.v.length; }
      else if (d.k === "content") {
        // types (u32 interleaved), uri count, uri strings, object count, external count
        const types = new Array(n);
        for (let i = 0; i < n; i++) types[i] = u32FromCol(Buffer.from([body[p + i], body[p + n + i], body[p + 2 * n + i], body[p + 3 * n + i]]));
        if (types.some(t => t !== 0 && t !== 2)) return null;
        let q = p + 4 * n; const cnt = body.readUInt32LE(q); q += 4;
        const spans = new Array(n).fill(null); let seen = 0;
        for (let i = 0; i < n; i++) if (types[i] === 2) { const l = 4 + body.readUInt32LE(q); spans[i] = [q, q + l]; q += l; seen++; if (q > body.length) return null; }
        if (seen !== cnt) return null;
        for (let i = 0; i < 8; i++) if (body[q + i] !== 0) return null;
        segs.push({ k: "content", types, spans }); p = q + 8;
      }
      else if (d.k === "var") {
        const spans = new Array(n), f = WALK[d.f];
        for (let i = 0; i < n; i++) { const l = f(body, p); spans[i] = [p, p + l]; p += l; if (p > body.length) return null; }
        segs.push({ k: "var", spans });
      }
    }
  } catch { return null; }
  return p === body.length ? segs : null;
}

function readRefs(b, off, n) {
  const out = new Array(n); let a = 0;
  for (let i = 0; i < n; i++) {
    const v = ((b[off + i] << 24) | (b[off + n + i] << 16) | (b[off + 2 * n + i] << 8) | b[off + 3 * n + i]) >>> 0;
    a += (v >>> 1) ^ -(v & 1); out[i] = a;
  }
  return out;
}
function writeRefs(vals) {
  const n = vals.length, out = Buffer.alloc(4 * n); let prev = 0;
  for (let i = 0; i < n; i++) {
    const d = vals[i] - prev; prev = vals[i];
    const z = ((d << 1) ^ (d >> 31)) >>> 0;
    out[i] = z >>> 24; out[n + i] = (z >>> 16) & 255; out[2 * n + i] = (z >>> 8) & 255; out[3 * n + i] = z & 255;
  }
  return out;
}

/* Build a new body from a layout: for each new element j choose old index src[j]
   (or -1 with `fresh` parts), optionally overriding parts. */
function rebuild(body, segs, n, src, override, nullRefs) {
  const m = src.length, out = [];
  segs.forEach((s, si) => { s.si = si; });
  for (const s of segs) {
    if (s.k === "lit") out.push(Buffer.from(s.v));
    else if (s.k === "content") {
      const types = Buffer.alloc(4 * m), uris = [];
      for (let j = 0; j < m; j++) {
        const t = s.types[src[j]];
        types[2 * m + j] = (t >> 8) & 255; types[3 * m + j] = t & 255;
        if (t === 2) uris.push(body.subarray(s.spans[src[j]][0], s.spans[src[j]][1]));
      }
      const cnt = Buffer.alloc(4); cnt.writeUInt32LE(uris.length);
      out.push(types, cnt, ...uris, Buffer.alloc(8));
    }
    else if (s.k === "col") {
      const b = Buffer.alloc(s.w * m);
      for (let j = 0; j < m; j++) for (let k = 0; k < s.w; k++) {
        const ov = override && override.get(j);
        b[k * m + j] = ov && ov[s.si] ? ov[s.si][k] : body[s.off + k * n + src[j]];
      }
      out.push(b);
    } else if (s.k === "plain") {
      const b = Buffer.alloc(s.w * m);
      for (let j = 0; j < m; j++) {
        const ov = override && override.get(j);
        (ov && ov[s.si] ? ov[s.si] : body.subarray(s.off + s.w * src[j], s.off + s.w * src[j] + s.w)).copy(b, j * s.w);
      }
      out.push(b);
    } else if (s.k === "ref") {
      const vals = readRefs(body, s.off, n);
      const nv = new Array(m);
      for (let j = 0; j < m; j++) {
        const ov = override && override.get(j);
        nv[j] = ov && ov[s.si] !== undefined ? ov[s.si] : vals[src[j]];
        if (nullRefs && nullRefs.has(nv[j])) nv[j] = -1;
      }
      out.push(writeRefs(nv));
    } else if (s.k === "var") {
      for (let j = 0; j < m; j++) {
        const ov = override && override.get(j);
        if (ov && ov[s.si]) out.push(ov[s.si]);
        else out.push(body.subarray(s.spans[src[j]][0], s.spans[src[j]][1]));
      }
    }
  }
  return Buffer.concat(out);
}

const keepAll = n => Array.from({ length: n }, (_, i) => i);

/* element parts: array aligned to segs (undefined for lit/zeros) */
function getParts(body, segs, n, i) {
  return segs.map(s => {
    if (s.k === "col") { const b = Buffer.alloc(s.w); for (let k = 0; k < s.w; k++) b[k] = body[s.off + k * n + i]; return b; }
    if (s.k === "plain") return body.subarray(s.off + s.w * i, s.off + s.w * i + s.w);
    if (s.k === "ref") return readRefs(body, s.off, n)[i];
    if (s.k === "var") return body.subarray(s.spans[i][0], s.spans[i][1]);
    return undefined;
  });
}

/* keep = indexes to keep; nullRefs = Set of ref values to turn into nil */
function filterBody(body, segs, n, keep, nullRefs) {
  return rebuild(body, segs, n, keep, null, nullRefs);
}

/* many edits at once: map of element index -> parts */
function replaceMany(body, segs, n, map) {
  return rebuild(body, segs, n, keepAll(n), map);
}

function replaceParts(body, segs, n, i, parts) {
  const ov = new Map(); ov.set(i, parts);
  return rebuild(body, segs, n, keepAll(n), ov);
}

function appendParts(body, segs, n, parts) {
  // new element copies element n-1's values except where parts override; handled by caller
  const src = keepAll(n).concat(0);
  const ov = new Map(); if (parts) ov.set(n, parts);
  return rebuild(body, segs, n, src, ov);
}

/* ---------- value codecs ---------- */
const f32 = new DataView(new ArrayBuffer(4));
function floatFromCol(b) { // b = 4 bytes big-endian rotated
  const u = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  f32.setUint32(0, ((u >>> 1) | (u << 31)) >>> 0);
  return f32.getFloat32(0);
}
function floatToCol(v) {
  f32.setFloat32(0, v);
  const bits = f32.getUint32(0), u = ((bits << 1) | (bits >>> 31)) >>> 0;
  return Buffer.from([u >>> 24, (u >>> 16) & 255, (u >>> 8) & 255, u & 255]);
}
const u32FromCol = b => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
const u32ToCol = v => Buffer.from([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
function intFromCol(b) { const u = u32FromCol(b); return (u >>> 1) ^ -(u & 1); }
function intToCol(v) { return u32ToCol(((v << 1) ^ (v >> 31)) >>> 0); }
function i64FromCol(b) { let u = 0n; for (const x of b) u = (u << 8n) | BigInt(x); return (u >> 1n) ^ -(u & 1n); }
function i64ToCol(v) {
  v = BigInt(v);
  let u = BigInt.asUintN(64, (v << 1n) ^ (v >> 63n)); const b = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { b[i] = Number(u & 255n); u >>= 8n; }
  return b;
}
const rnd = v => Math.round(v * 1e5) / 1e5;

const ROT_IDS = {}; // rotation ids are only displayed, never changed

/* decode element parts -> display value (JSON-safe) ; null when not shown */
function decode(type, parts) {
  switch (type) {
    case 0x01: return parts[0].toString("utf8", 4);
    case 0x02: return !!parts[0][0];
    case 0x03: return intFromCol(parts[0]);
    case 0x04: return rnd(floatFromCol(parts[0]));
    case 0x05: return rnd(parts[0].readDoubleLE(0));
    case 0x12: case 0x0b: return u32FromCol(parts[0]);
    case 0x0c: return parts.map(p => rnd(floatFromCol(p)));
    case 0x1a: return parts.map(p => p[0]);
    case 0x0d: case 0x0e: case 0x06: return parts.map(p => (type === 0x06 && false ? intFromCol(p) : rnd(floatFromCol(p))));
    case 0x07: return [rnd(floatFromCol(parts[0])), intFromCol(parts[2]), rnd(floatFromCol(parts[1])), intFromCol(parts[3])]; // sx, ox, sy, oy
    case 0x10: return parts.slice(1).map(p => rnd(floatFromCol(p))); // position
    case 0x1b: return String(i64FromCol(parts[0]));
    case 0x13: return { ref: parts[0] };
    default: return null;
  }
}

/* encode a value into new parts (starting from the old parts); throws on bad input */
function encode(type, value, old) {
  const num = (v, what) => { const x = Number(v); if (!Number.isFinite(x)) throw new Error(what + " must be a number."); return x; };
  const arr = (len) => { if (!Array.isArray(value) || value.length !== len) throw new Error("Expected " + len + " numbers."); return value.map((v, i) => num(v, "Value " + (i + 1))); };
  const out = old.slice();
  switch (type) {
    case 0x01: { const s = Buffer.from(String(value), "utf8"), h = Buffer.alloc(4); h.writeUInt32LE(s.length); out[0] = Buffer.concat([h, s]); return out; }
    case 0x02: out[0] = Buffer.from([value === true || value === "true" || value === 1 ? 1 : 0]); return out;
    case 0x03: { const v = num(value, "Value"); if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw new Error("Whole number required."); out[0] = intToCol(v); return out; }
    case 0x04: out[0] = floatToCol(num(value, "Value")); return out;
    case 0x05: { const b = Buffer.alloc(8); b.writeDoubleLE(num(value, "Value")); out[0] = b; return out; }
    case 0x12: case 0x0b: { const v = num(value, "Value"); if (!Number.isInteger(v) || v < 0 || v > 4294967295) throw new Error("Whole number required."); out[0] = u32ToCol(v); return out; }
    case 0x0c: case 0x0d: case 0x0e: return arr(type === 0x0d ? 2 : 3).map(v => floatToCol(v));
    case 0x1a: return arr(3).map(v => { if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error("Colors are 0 to 255."); return Buffer.from([v]); });
    case 0x06: { const a = arr(2); if (!Number.isInteger(a[1])) throw new Error("Offset must be whole."); return [floatToCol(a[0]), intToCol(a[1])]; }
    case 0x07: { const a = arr(4); if (!Number.isInteger(a[1]) || !Number.isInteger(a[3])) throw new Error("Offsets must be whole."); return [floatToCol(a[0]), floatToCol(a[2]), intToCol(a[1]), intToCol(a[3])]; }
    case 0x10: { const a = arr(3); return [old[0], floatToCol(a[0]), floatToCol(a[1]), floatToCol(a[2])]; }
    case 0x1b: { try { out[0] = i64ToCol(String(value).trim()); } catch { throw new Error("Whole number required."); } return out; }
    default: throw new Error("This property type can't be edited yet.");
  }
}
const EDITABLE = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x12, 0x0b, 0x0c, 0x0d, 0x0e, 0x1a, 0x06, 0x07, 0x10, 0x1b]);

module.exports = { replaceMany, layout, rebuild, keepAll, getParts, filterBody, replaceParts, appendParts, readRefs, writeRefs, decode, encode, EDITABLE, floatFromCol, floatToCol, u32FromCol, u32ToCol };

  return module.exports;
})();

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

module.exports = function install(app, express, { getSession, getData, refreshLists }) {
  const J = express.text({ type: "*/*", limit: "10mb" });

  /* ---------- model (lazy) ---------- */
  function model(s) {
    if (s.ex) return s.ex;
    const meta = s.pl.meta;
    const clsOf = new Int32Array(meta.maxRef + 2).fill(-1);
    for (const info of meta.classes.values()) for (const r of info.refs) clsOf[r] = info.cid;
    const kids = new Map();
    const d = getData(meta.prnt), n = d.readUInt32LE(1);
    const ks = core.readRefs(d, 5, n), ps = core.readRefs(d, 5 + 4 * n, n);
    for (let i = 0; i < n; i++) {
      let a = kids.get(ps[i]); if (!a) kids.set(ps[i], a = []);
      a.push(ks[i]);
    }
    s.ex = { clsOf, kids };
    return s.ex;
  }
  const clsName = (s, ref) => { const m = model(s); const info = s.pl.meta.classes.get(m.clsOf[ref]); return info ? info.cn : "?"; };
  const nameOf = (s, ref) => s.pl.meta.names.get(ref) ?? "?";
  function pathOf(s, ref) {
    const o = []; const par = s.pl.meta.parent;
    for (let g = 0; ref !== undefined && ref !== -1 && g < 200; g++) { o.push(nameOf(s, ref)); ref = par.get(ref); }
    return o.reverse().join("/");
  }
  const exists = (s, ref) => Number.isInteger(ref) && ref >= 0 && ref <= s.pl.meta.maxRef && model(s).clsOf[ref] >= 0 && s.pl.meta.parent.has(ref);
  function subtree(s, root) {
    const m = model(s), out = [], st = [root];
    while (st.length) { const r = st.pop(); out.push(r); const k = m.kids.get(r); if (k) for (const x of k) st.push(x); }
    return out;
  }
  const brief = (s, r) => {
    const k = model(s).kids.get(r);
    return { id: r, name: nameOf(s, r), cls: clsName(s, r), kids: k ? k.length : 0 };
  };

  /* ---------- chunk helpers ---------- */
  function propChunks(s, info) { return s.pl.meta.props.get(info.cid) || []; }
  function chunkInfo(c) {
    if (c.pi) return c.pi;
    const d = getData(c), l = d.readUInt32LE(4);
    c.pi = { name: d.toString("utf8", 8, 8 + l), type: d[8 + l], H: 9 + l };
    return c.pi;
  }
  function chunkLayout(c, n) {
    const d = getData(c), pi = chunkInfo(c);
    const segs = core.layout(pi.type, d.subarray(pi.H), n);
    return { d, pi, segs, body: d.subarray(pi.H) };
  }
  function commit(c, data) { c.data = data; c.mod = true; c.z = null; }

  /* ---------- tree / search ---------- */
  /* ---------- delete ---------- */
  app.post("/api/delete", J, (req, res) => {
    const s = getSession(req, res); if (!s) return;
    try {
      const b = JSON.parse(req.body || "{}");
      const id = Number(b.id);
      if (!exists(s, id)) throw new Error("Item not found.");
      const meta = s.pl.meta, m = model(s), pl = s.pl;
      const rootInfo = meta.classes.get(m.clsOf[id]);
      if (rootInfo.service) throw new Error("Services can't be deleted.");
      const D = subtree(s, id), Dset = new Set(D);
      // per class: which elements go
      const hit = new Map();
      for (const r of D) { const cid = m.clsOf[r]; let a = hit.get(cid); if (!a) hit.set(cid, a = new Set()); a.add(r); }
      for (const cid of hit.keys()) if (meta.classes.get(cid).service) throw new Error("This contains a service, which can't be deleted.");
      if (b.dry) {
        const counts = {}; for (const [cid, set] of hit) counts[meta.classes.get(cid).cn] = set.size;
        return res.json({ ok: true, total: D.length, counts });
      }
      const pending = [];   // [chunk, newData]
      const drop = new Set(); // chunks to remove
      const dropClass = new Set();
      // 1) classes touched
      for (const [cid, set] of hit) {
        const info = meta.classes.get(cid), n = info.refs.length;
        const keep = []; info.refs.forEach((r, i) => { if (!set.has(r)) keep.push(i); });
        const d = getData(info.chunk), l = d.readUInt32LE(4), p = 8 + l;
        if (d[p] !== 0) throw new Error("Unexpected class layout.");
        if (!keep.length) { dropClass.add(cid); drop.add(info.chunk); for (const c of propChunks(s, info)) drop.add(c); continue; }
        const nr = keep.map(i => info.refs[i]);
        pending.push([info.chunk, Buffer.concat([d.subarray(0, p + 1), le32(nr.length), core.writeRefs(nr), d.subarray(p + 5 + 4 * n)])]);
        for (const c of propChunks(s, info)) {
          const { d: pd, pi, segs, body } = chunkLayout(c, n);
          if (!segs) throw new Error("Can't delete safely: " + info.cn + "." + pi.name + " uses a data type I don't support yet.");
          pending.push([c, Buffer.concat([pd.subarray(0, pi.H), core.filterBody(body, segs, n, keep, Dset)])]);
        }
      }
      // 2) other classes: references to deleted things become nil
      for (const [cid, info] of meta.classes) {
        if (hit.has(cid)) continue;
        for (const c of propChunks(s, info)) {
          const pi = chunkInfo(c); if (pi.type !== 0x13) continue;
          const n = info.refs.length, { d: pd, segs, body } = chunkLayout(c, n);
          if (!segs) throw new Error("Unexpected reference layout.");
          const vals = core.readRefs(body, 0, n);
          if (!vals.some(v => Dset.has(v))) continue;
          pending.push([c, Buffer.concat([pd.subarray(0, pi.H), core.writeRefs(vals.map(v => (Dset.has(v) ? -1 : v)))])]);
        }
      }
      // 3) parent table
      { const c = meta.prnt, d = getData(c), n = d.readUInt32LE(1);
        const ks = core.readRefs(d, 5, n), ps = core.readRefs(d, 5 + 4 * n, n);
        const k2 = [], p2 = [];
        for (let i = 0; i < n; i++) if (!Dset.has(ks[i])) { k2.push(ks[i]); p2.push(ps[i]); }
        pending.push([c, Buffer.concat([d.subarray(0, 1), le32(k2.length), core.writeRefs(k2), core.writeRefs(p2)])]); }
      // ---- commit (nothing above has changed state) ----
      for (const [c, nd] of pending) if (!drop.has(c)) commit(c, nd);
      for (const [cid, set] of hit) {
        const info = meta.classes.get(cid);
        if (!dropClass.has(cid)) info.refs = info.refs.filter(r => !set.has(r));
      }
      if (dropClass.size) {
        pl.chunks = pl.chunks.filter(c => !drop.has(c));
        const order = [...meta.classes.values()].filter(i => !dropClass.has(i.cid));
        const remap = new Map(); order.forEach((i, k) => remap.set(i.cid, k));
        for (const i of order) {
          const nid = remap.get(i.cid);
          if (nid === i.cid) continue;
          for (const c of [i.chunk, ...propChunks(s, i)]) { const dd = Buffer.from(getData(c)); dd.writeUInt32LE(nid, 0); commit(c, dd); c.pi = null; }
        }
        meta.classes = new Map(); meta.byName = new Map(); const np = new Map();
        for (const i of order) {
          const oldCid = i.cid; i.cid = remap.get(oldCid);
          meta.classes.set(i.cid, i); meta.byName.set(i.cn, i);
          if (meta.props.has(oldCid)) np.set(i.cid, meta.props.get(oldCid));
        }
        meta.props = np;
        pl.header.writeInt32LE(pl.header.readInt32LE(16) - dropClass.size, 16);
        s.ex = null;
      }
      pl.header.writeInt32LE(pl.header.readInt32LE(20) - D.length, 20);
      // parent / names / kids bookkeeping
      const old = meta.parent.get(id);
      for (const r of D) { meta.parent.delete(r); meta.names.delete(r); }
      if (s.ex) {
        const ol = s.ex.kids.get(old); if (ol) ol.splice(ol.indexOf(id), 1);
        for (const r of D) { s.ex.kids.delete(r); s.ex.clsOf[r] = -1; }
      }
      res.json({ ok: true, removed: D.length, ...refreshLists(s) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  function le32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
};
