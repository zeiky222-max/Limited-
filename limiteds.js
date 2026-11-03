// Vercel serverless function: looks up a Roblox user and their Limited items.
// Runs on the server, so there are no browser CORS problems.
const H = { "Content-Type": "application/json", "Accept": "application/json" };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  const username = String(req.query.username || "").trim();
  if (!username) return res.status(400).json({ status: "error", message: "Enter a username." });

  try {
    // 1) username -> user id
    const u = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST", headers: H,
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
    });
    if (!u.ok) return res.status(502).json({ status: "error", message: "Roblox user lookup failed." });
    const found = (await u.json()).data;
    if (!found.length) return res.status(404).json({ status: "notfound" });
    const user = { id: found[0].id, name: found[0].name, displayName: found[0].displayName };

    // 2) collectibles (Limiteds), paginated
    const items = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const url = `https://inventory.roblox.com/v1/users/${user.id}/assets/collectibles?sortOrder=Asc&limit=100` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const r = await fetch(url, { headers: H });
      if (r.status === 403) return res.status(200).json({ status: "private", user });
      if (r.status === 429) return res.status(429).json({ status: "error", message: "Roblox rate limit. Try again in a minute." });
      if (!r.ok) return res.status(502).json({ status: "error", message: "Could not load the inventory." });
      const j = await r.json();
      items.push(...j.data);
      cursor = j.nextPageCursor;
      if (!cursor) break;
    }

    // 3) group duplicates
    const map = new Map();
    for (const it of items) {
      if (!map.has(it.assetId)) map.set(it.assetId, { assetId: it.assetId, name: it.name, rap: it.recentAveragePrice || 0, count: 0, serials: [] });
      const g = map.get(it.assetId);
      g.count++;
      if (it.serialNumber) g.serials.push(it.serialNumber);
    }
    const groups = [...map.values()].sort((a, b) => b.rap - a.rap);

    // 4) thumbnails
    const ids = groups.map((g) => g.assetId);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
    const thumbs = {};
    await Promise.all(chunks.map(async (c) => {
      const t = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${c.join(",")}&returnPolicy=PlaceHolder&size=150x150&format=Png`, { headers: H });
      if (t.ok) (await t.json()).data.forEach((d) => { thumbs[d.targetId] = d.imageUrl; });
    }));
    groups.forEach((g) => { g.img = thumbs[g.assetId] || ""; });

    const totalRap = items.reduce((s, i) => s + (i.recentAveragePrice || 0), 0);
    return res.status(200).json({ status: "ok", user, total: items.length, totalRap, groups });
  } catch (e) {
    return res.status(500).json({ status: "error", message: "Server error. Try again." });
  }
};
