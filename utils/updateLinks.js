
import { createClient } from "@libsql/client";
import ytdl from "ytdl-core";

const DEFAULT_CHANNELS_JSON_URL = "https://drive.google.com/uc?export=download&id=1y_baDMf3VVYrksEhbE2YQZ5td0REd89p";

function nowIso(){ return new Date().toISOString(); }

async function ensureSchema(db){
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

async function setLastUpdate(db, value){
  await db.execute({
    sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: ["last_update", value]
  });
}

export async function updateLinks({ tursoUrl, tursoToken, db, channelsUrl, concurrency = 6, logger = console }){
  if(!db){
    if(!tursoUrl || !tursoToken) throw new Error("tursoUrl/tursoToken required");
    const dbUrl = tursoUrl.startsWith("libsql://") ? tursoUrl.replace("libsql://","https://") : tursoUrl;
    db = createClient({ url: dbUrl, authToken: tursoToken });
  }
  await ensureSchema(db);
  const chUrl = channelsUrl || process.env.CHANNELS_JSON_URL || DEFAULT_CHANNELS_JSON_URL;
  logger.log("Fetching channels from", chUrl);
  const res = await fetch(chUrl, { cache: "no-store" });
  if(!res.ok) throw new Error("Failed to fetch channels.json: HTTP " + res.status);
  const body = await res.text();
  let data;
  try{ data = JSON.parse(body); } catch(e){ throw new Error("Invalid channels JSON: " + e.message); }
  const channels = Array.isArray(data) ? data : (data.channels || []);
  if(!channels.length) throw new Error("No channels in channels.json");
  const results = [];
  const pool = [];
  for(const ch of channels){
    const p = (async ()=>{
      const name = ch.name || ch.title || ch.id || ("c_"+Math.random().toString(36).slice(2,7));
      const url = ch.url || ch.watchUrl || ch.link;
      if(!url){ results.push({ name, ok:false, reason:"missing-url" }); return; }
      // try youtube
      try{
        const u = new URL(url);
        if(u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")){
          try{
            const info = await ytdl.getInfo(url);
            const fmts = info.formats || [];
            const hls = fmts.find(f => f.isHLS || (f.mimeType && (f.mimeType.includes("mpegurl") || f.mimeType.includes("vnd.apple.mpegurl"))));
            if(hls && hls.url){ results.push({ name, ok:true, m3u8:hls.url, extractor:"ytdl-core", quality:hls.qualityLabel||null }); return; }
          }catch(e){ logger.warn("ytdl failed for", name, e && e.message); }
        }
      }catch(e){ /* ignore */ }
      // probe
      try{
        if(url.includes(".m3u8")){ results.push({ name, ok:true, m3u8:url, extractor:"probe" }); return; }
        const head = await fetch(url, { method:"HEAD", redirect:"follow" });
        const ct = head.headers.get("content-type") || "";
        if(ct.includes("mpegurl")){ results.push({ name, ok:true, m3u8:url, extractor:"probe" }); return; }
      }catch(e){ logger.warn("probe failed for", name, e && e.message); }
      results.push({ name, ok:false, reason:"no-m3u8" });
    })();
    pool.push(p);
    if(pool.length >= concurrency){ await Promise.race(pool).catch(()=>{}); }
  }
  await Promise.all(pool);
  const okRows = results.filter(r=>r.ok && r.m3u8);
  const failed = results.filter(r=>!r.ok);
  logger.log("Extracted", okRows.length, "m3u8 URLs; failed", failed.length);
  let updated=0;
  for(const r of okRows){
    await db.execute({
      sql: `INSERT INTO links (name, m3u8_url, extractor, quality, last_updated)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET m3u8_url=excluded.m3u8_url, extractor=excluded.extractor, quality=excluded.quality, last_updated=excluded.last_updated`,
      args: [r.name, r.m3u8, r.extractor, r.quality || null, nowIso()]
    });
    updated++;
  }
  await setLastUpdate(db, nowIso());
  return { processed: results.length, updated, failed: failed.length, failures: failed.slice(0,20) };
}
