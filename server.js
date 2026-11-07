const express = require("express");
const zlib = require("zlib");
const crypto = require("crypto");
const path = require("path");
const app = express();

/* ------------------------------------------------------------------ */
/*  Binary .rbxl reader / writer (only touches script Source strings)  */
/* ------------------------------------------------------------------ */

// LZ4 block decoder (older place files use LZ4, newer ones use zstd)
function lz4(src, usize) {
  const out = Buffer.alloc(usize);
  let i = 0, o = 0;
  while (i < src.length) {
    const t = src[i++];
    let ll = t >> 4;
    if (ll === 15) { let b; do { b = src[i++]; ll += b; } while (b === 255); }
    src.copy(out, o, i, i + ll); i += ll; o += ll;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let ml = t & 15;
    if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let k = 0; k < ml; k++, o++) out[o] = out[o - off];
  }
  return out;
}

function getData(c) {
  if (c.data) return c.data;
  if (c.cl === 0) c.data = c.raw;
  else if (c.raw.readUInt32LE(0) === 0xFD2FB528) c.data = zlib.zstdDecompressSync(c.raw);
  else c.data = lz4(c.raw, c.ul);
  return c.data;
}

function readRefs(b, n) {
  const out = new Array(n);
  let a = 0;
  for (let i = 0; i < n; i++) {
    const v = ((b[i] << 24) | (b[n + i] << 16) | (b[2 * n + i] << 8) | b[3 * n + i]) >>> 0;
    a += (v >>> 1) ^ -(v & 1);
    out[i] = a;
  }
  return out;
}

function parsePlace(buf) {
  if (buf.toString("latin1", 0, 8) !== "<roblox!")
    throw new Error("This is not a binary .rbxl place file.");
  let p = 32;
  const chunks = [];
  while (p < buf.length) {
    const name = buf.toString("latin1", p, p + 4);
    const cl = buf.readUInt32LE(p + 4), ul = buf.readUInt32LE(p + 8);
    p += 16;
    const len = cl === 0 ? ul : cl;
    chunks.push({ name, cl, ul, raw: buf.subarray(p, p + len), data: null, offs: null });
    p += len;
    if (name.startsWith("END")) break;
  }
  return { header: Buffer.from(buf.subarray(0, 32)), chunks };
}

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

function indexPlace(pl) {
  const classes = new Map(), parent = new Map(), names = new Map();
  for (const c of pl.chunks) {
    if (c.name !== "INST") continue;
    const d = getData(c);
    const cid = d.readUInt32LE(0), l = d.readUInt32LE(4);
    const cn = d.toString("utf8", 8, 8 + l);
    const p = 8 + l;
    const n = d.readUInt32LE(p + 1);
    classes.set(cid, { cn, refs: readRefs(d.subarray(p + 5, p + 5 + 4 * n), n) });
    c.data = null;
  }
  const scripts = [];
  for (const c of pl.chunks) {
    if (c.name === "PRNT") {
      const d = getData(c);
      const n = d.readUInt32LE(1);
      const kids = readRefs(d.subarray(5, 5 + 4 * n), n);
      const pars = readRefs(d.subarray(5 + 4 * n, 5 + 8 * n), n);
      for (let i = 0; i < n; i++) parent.set(kids[i], pars[i]);
      c.data = null;
    } else if (c.name === "PROP") {
      const d = getData(c);
      const cid = d.readUInt32LE(0), l = d.readUInt32LE(4);
      const pn = d.toString("utf8", 8, 8 + l), type = d[8 + l];
      const cls = classes.get(cid);
      const isSource = pn === "Source" && SCRIPT_CLASSES.has(cls.cn);
      if (type === 1 && (pn === "Name" || isSource)) {
        let q = 9 + l;
        const offs = new Array(cls.refs.length);
        for (let i = 0; i < cls.refs.length; i++) {
          offs[i] = q;
          const sl = d.readUInt32LE(q);
          if (pn === "Name") names.set(cls.refs[i], d.toString("utf8", q + 4, q + 4 + sl));
          q += 4 + sl;
        }
        if (q > d.length) throw new Error("Unexpected data layout in place file.");
        if (isSource) {
          c.offs = offs;
          cls.refs.forEach((ref, idx) => scripts.push({ id: ref, cls: cls.cn, chunk: c, idx, dirty: false }));
          continue; // keep decompressed data for Source chunks
        }
      }
      c.data = null;
    }
  }
  const pathOf = r => {
    const o = [];
    while (r !== undefined && r !== -1 && names.has(r)) { o.push(names.get(r)); r = parent.get(r); }
    return o.reverse().join("/");
  };
  for (const s of scripts) s.path = pathOf(s.id);
  return scripts;
}

function readSource(sc) {
  const c = sc.chunk, d = getData(c), off = c.offs[sc.idx];
  return d.toString("utf8", off + 4, off + 4 + d.readUInt32LE(off));
}

function srcLen(sc) {
  const c = sc.chunk;
  return getData(c).readUInt32LE(c.offs[sc.idx]);
}

function setSource(sc, text) {
  const c = sc.chunk, d = getData(c), off = c.offs[sc.idx];
  const oldLen = d.readUInt32LE(off);
  const nb = Buffer.from(text, "utf8");
  const lb = Buffer.alloc(4);
  lb.writeUInt32LE(nb.length);
  c.data = Buffer.concat([d.subarray(0, off), lb, nb, d.subarray(off + 4 + oldLen)]);
  c.mod = true; c.z = null; // recompressed when the file is built
  const delta = nb.length - oldLen;
  for (let i = sc.idx + 1; i < c.offs.length; i++) c.offs[i] += delta;
  sc.dirty = true;
}

function serialize(pl) {
  const parts = [pl.header];
  for (const c of pl.chunks) {
    let raw = c.raw, cl = c.cl, ul = c.ul;
    if (c.mod) {
      if (!c.z) c.z = zlib.zstdCompressSync(c.data);
      ul = c.data.length;
      if (c.z.length < ul) { raw = c.z; cl = c.z.length; } else { raw = c.data; cl = 0; }
    }
    const h = Buffer.alloc(16);
    h.write(c.name, 0, 4, "latin1");
    h.writeUInt32LE(cl, 4);
    h.writeUInt32LE(ul, 8);
    parts.push(h, raw);
  }
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/*  In-memory sessions (the uploaded place lives here for up to 1 hour) */
/* ------------------------------------------------------------------ */
const sessions = new Map();
function newSession(pl, scripts) {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  while (sessions.size >= 3) sessions.delete(sessions.keys().next().value);
  const id = crypto.randomBytes(16).toString("hex");
  sessions.set(id, { pl, scripts, byId: new Map(scripts.map(s => [s.id, s])), exp: now + 3600e3 });
  return id;
}
function getSession(req, res) {
  const s = sessions.get(String(req.query.s || ""));
  if (!s || s.exp < Date.now()) {
    res.status(404).json({ error: "Session expired. Please upload the place file again." });
    return null;
  }
  s.exp = Date.now() + 3600e3;
  return s;
}

/* ------------------------------------------------------------------ */
/*  Roblox Open Cloud                                                   */
/* ------------------------------------------------------------------ */
async function sendToRoblox({ apiKey, universeId, placeId, versionType, body, ext }) {
  const url = `https://apis.roblox.com/universes/v1/${universeId}/places/${placeId}/versions?versionType=${versionType}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": ext === ".rbxlx" ? "application/xml" : "application/octet-stream",
    },
    body,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, body: r.ok ? { ok: true, ...data } : { error: data.message || data.error || text || "Roblox rejected the request.", status: r.status } };
}

/* ------------------------------------------------------------------ */
/*  Routes                                                              */
/* ------------------------------------------------------------------ */
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "editor.html")));
app.get("/classic", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Upload a .rbxl and list its scripts
app.post("/api/scan", express.raw({ type: "*/*", limit: "100mb" }), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "File is empty." });
    const pl = parsePlace(req.body);
    const scripts = indexPlace(pl);
    const id = newSession(pl, scripts);
    res.json({
      session: id,
      scripts: scripts.map(s => ({ id: s.id, cls: s.cls, len: srcLen(s), path: s.path })),
    });
  } catch (e) {
    res.status(400).json({ error: "Could not read the file: " + e.message });
  }
});

app.get("/api/script", (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const sc = s.byId.get(Number(req.query.id));
  if (!sc) return res.status(404).json({ error: "Script not found." });
  res.json({ source: readSource(sc) });
});

app.post("/api/script", express.text({ type: "*/*", limit: "10mb" }), (req, res) => {
  const s = getSession(req, res); if (!s) return;
  const sc = s.byId.get(Number(req.query.id));
  if (!sc) return res.status(404).json({ error: "Script not found." });
  try {
    setSource(sc, typeof req.body === "string" ? req.body : "");
    res.json({ ok: true, len: srcLen(sc), changed: s.scripts.filter(x => x.dirty).length });
  } catch (e) {
    res.status(500).json({ error: "Could not save: " + e.message });
  }
});

app.get("/api/download", (req, res) => {
  const s = getSession(req, res); if (!s) return;
  res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="edited.rbxl"' });
  res.send(serialize(s.pl));
});

// Publish the edited place (key passes through memory only, never stored or logged)
app.post("/api/publish", async (req, res) => {
  try {
    const s = getSession(req, res); if (!s) return;
    const apiKey = req.get("x-api-key");
    const universeId = (req.get("x-universe-id") || "").trim();
    const placeId = (req.get("x-place-id") || "").trim();
    const versionType = req.get("x-version-type") === "Saved" ? "Saved" : "Published";
    if (!apiKey || !/^\d+$/.test(universeId) || !/^\d+$/.test(placeId))
      return res.status(400).json({ error: "API key, numeric Universe ID and Place ID are required." });
    const out = await sendToRoblox({ apiKey, universeId, placeId, versionType, body: serialize(s.pl), ext: ".rbxl" });
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
});

// Original upload-only publisher (kept at /classic)
app.post("/publish", express.raw({ type: "*/*", limit: "100mb" }), async (req, res) => {
  try {
    const apiKey = req.get("x-api-key");
    const universeId = (req.get("x-universe-id") || "").trim();
    const placeId = (req.get("x-place-id") || "").trim();
    const ext = (req.get("x-file-ext") || "").toLowerCase();
    const versionType = req.get("x-version-type") === "Saved" ? "Saved" : "Published";
    if (!apiKey || !/^\d+$/.test(universeId) || !/^\d+$/.test(placeId))
      return res.status(400).json({ error: "API key, numeric Universe ID and Place ID are required." });
    if (![".rbxl", ".rbxlx"].includes(ext))
      return res.status(400).json({ error: "File must be .rbxl or .rbxlx." });
    if (!req.body || !req.body.length) return res.status(400).json({ error: "File is empty." });
    const out = await sendToRoblox({ apiKey, universeId, placeId, versionType, body: req.body, ext });
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on port " + port));
