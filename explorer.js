"use strict";
/* Delete a script / item (and everything inside it) from the in-memory place. */
const core = require("./rbxcore");

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
