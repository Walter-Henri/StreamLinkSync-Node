
import ytdl from "ytdl-core";
import pLimit from "p-limit";
import { createClient } from "@libsql/client";

const DEFAULT_CHANNELS_JSON_URL = "https://drive.google.com/uc?export=download&id=1y_baDMf3VVYrksEhbE2YQZ5td0REd89p";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export async function createDb() {
  const rawUrl = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  if (!rawUrl || !token) throw new Error("TURSO_URL/TURSO_TOKEN not configured");
  const dbUrl = rawUrl.startsWith("libsql://") ? rawUrl.replace("libsql://", "https://") : rawUrl;
  return createClient({ url: dbUrl, authToken: token });
}

export async function ensureSchema(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS links (
    name TEXT PRIMARY KEY,
    m3u8_url TEXT,
    extractor TEXT,
    quality TEXT,
    last_updated TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}

export async function getLastUpdate(db) {
  const rs = await db.execute({ sql: "SELECT value FROM meta WHERE key = 'last_update'", args: [] });
  if (!rs.rows || rs.rows.length === 0) return null;
  return rs.rows[0].value;
}

export async function setLastUpdate(db, value) {
  await db.execute({
    sql: "INSERT INTO meta (key, value) VALUES ('last_update', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [value]
  });
}

function isoNow() { return new Date().toISOString(); }

async function probeForM3u8(url) {
  try {
    if (url.includes(".m3u8")) return url;
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    const ct = head.headers.get("content-type") || "";
    if (ct.includes("mpegurl")) return url;
  } catch (e) {
    // ignore probe errors
  }
  return null;
}

export async function extractLinksFromChannels(db, channels) {
  const limit = pLimit(6);
  const tasks = channels.map(ch => limit(async () => {
    const name = ch.name || ch.title || ch.id || ("channel_" + Math.random().toString(36).slice(2,8));
    const url = ch.url || ch.watchUrl || ch.link;
    if (!url) return { name, ok:false, reason:"missing-url" };

    // Try YouTube
    try {
      const u = new URL(url);
      if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
        try {
          const info = await ytdl.getInfo(url);
          const fmts = info.formats || [];
          const hls = fmts.find(f => f.isHLS || (f.mimeType && (f.mimeType.includes("mpegurl") || f.mimeType.includes("vnd.apple.mpegurl"))));
          if (hls && hls.url) return { name, ok:true, m3u8:hls.url, extractor:"ytdl-core", quality: hls.qualityLabel || null };
        } catch (e) {
          // fallback
        }
      }
    } catch (e) {}

    // Generic probe
    const probed = await probeForM3u8(url);
    if (probed) return { name, ok:true, m3u8:probed, extractor:"probe", quality:null };

    return { name, ok:false, reason:"no-m3u8" };
  }));

  const results = await Promise.all(tasks);
  const ok = results.filter(r => r.ok && r.m3u8);
  return { results, ok };
}

export async function updateLinksFromChannels(channelsUrl) {
  const db = await createDb();
  await ensureSchema(db);
  const last = await getLastUpdate(db);
  const now = isoNow();
  if (last) {
    const elapsed = Date.parse(now) - Date.parse(last);
    if (elapsed < SIX_HOURS_MS) {
      return { skipped:true, last, elapsed_ms: elapsed };
    }
  }

  // fetch channels json
  const chRes = await fetch(channelsUrl || DEFAULT_CHANNELS_JSON_URL, { cache: "no-store" });
  if (!chRes.ok) throw new Error("Failed to fetch channels.json: HTTP " + chRes.status);
  const txt = await chRes.text();
  let data;
  try { data = JSON.parse(txt); } catch (e) { throw new Error("channels.json invalid: " + e.message); }
  const channels = Array.isArray(data) ? data : (data.channels || []);
  if (!channels.length) throw new Error("channels list empty");

  const { results, ok } = await extractLinksFromChannels(db, channels);

  // upsert ok rows
  let updated = 0;
  for (const r of ok) {
    await db.execute({
      sql: `INSERT INTO links (name, m3u8_url, extractor, quality, last_updated)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET m3u8_url=excluded.m3u8_url, extractor=excluded.extractor, quality=excluded.quality, last_updated=excluded.last_updated`,
      args: [r.name, r.m3u8, r.extractor, r.quality, isoNow()]
    });
    updated++;
  }

  await setLastUpdate(db, isoNow());
  return { skipped:false, processed: channels.length, updated, failed: results.length - ok.length };
}
