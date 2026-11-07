const express = require("express");
const path = require("path");
const app = express();

// Serve the page
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Receive the raw place file and forward it to Roblox Open Cloud.
// The API key is only passed through in memory; it is never stored or logged.
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
    if (!req.body || !req.body.length)
      return res.status(400).json({ error: "File is empty." });

    const url = `https://apis.roblox.com/universes/v1/${universeId}/places/${placeId}/versions?versionType=${versionType}`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": ext === ".rbxlx" ? "application/xml" : "application/octet-stream",
      },
      body: req.body,
    });

    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(r.status).json(r.ok ? { ok: true, ...data } : { error: data.message || data.error || text || "Roblox rejected the request.", status: r.status });
  } catch (e) {
    res.status(500).json({ error: "Server error: " + e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on port " + port));
