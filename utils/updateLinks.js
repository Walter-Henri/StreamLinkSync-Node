
import ytdl from "ytdl-core";
import pLimit from "p-limit";
import { createClient } from "@libsql/client";

const DEFAULT_CHANNELS_JSON_URL = process.env.CHANNELS_JSON_URL || "https://drive.google.com/uc?export=download&id=1y_baDMf3VVYrksEhbE2YQZ5td0REd89p";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export async function createDb() {
  const rawUrl = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  if (!rawUrl || !token) throw new Error("TURSO_URL or TURSO_TOKEN not configured");
  const dbUrl = rawUrl.startsWith("libsql://") ? rawUrl.replace("libsql://", "https://") : rawUrl;
  return createClient({ url: dbUrl, authToken: token });
}

// --- substitua/cole esta função no utils/updateLinks.js ---
export async function ensureSchema(db) {
  // esquema desejado
  const desiredCols = [
    { name: "name", type: "TEXT" },
    { name: "url", type: "TEXT" },
    { name: "extractor", type: "TEXT" },
    { name: "quality", type: "TEXT" },
    { name: "last_updated", type: "TEXT" }
  ];

  // 1) cria a tabela caso não exista (com todas as colunas)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS live_links (
      name TEXT PRIMARY KEY,
      url TEXT,
      extractor TEXT,
      quality TEXT,
      last_updated TEXT
    )
  `);

  // 2) consulta colunas existentes
  let info;
  try {
    const rs = await db.execute({ sql: "PRAGMA table_info('live_links')", args: [] });
    info = rs.rows || [];
  } catch (e) {
    console.log("[migrate] PRAGMA failed:", e && (e.message || e));
    info = [];
  }
  const existing = new Set(info.map(r => r.name));

  // 3) detecta colunas faltantes
  const missing = desiredCols.filter(c => !existing.has(c.name));
  if (missing.length === 0) {
    console.log("[migrate] live_links schema already up-to-date");
    return;
  }
  console.log("[migrate] missing columns detected:", missing.map(c=>c.name));

  // 4) tenta ALTER TABLE ADD COLUMN para cada coluna faltante
  const alterErrors = [];
  for (const col of missing) {
    try {
      const sql = `ALTER TABLE live_links ADD COLUMN ${col.name} ${col.type}`;
      await db.execute({ sql, args: [] });
      console.log("[migrate] added column:", col.name);
    } catch (e) {
      console.error("[migrate] ALTER TABLE failed for", col.name, e && (e.message || e));
      alterErrors.push(col.name);
    }
  }

  // 5) se algum ALTER TABLE falhou, fazer migração segura (cria tabela nova, copia dados)
  if (alterErrors.length > 0) {
    console.log("[migrate] performing fallback migration for columns:", alterErrors);
    // nome temporário
    const tmp = "live_links_new";
    // cria tabela nova com esquema correto
    await db.execute(`
      CREATE TABLE IF NOT EXISTS ${tmp} (
        name TEXT PRIMARY KEY,
        url TEXT,
        extractor TEXT,
        quality TEXT,
        last_updated TEXT
      )
    `);
    // copia colunas compatíveis (apenas as que existem atualmente)
    const commonCols = [...existing].filter(c => ["name","url","extractor","quality","last_updated"].includes(c));
    const commonColsList = commonCols.length ? commonCols.join(",") : "name";
    // insere dados existentes na nova tabela
    try {
      await db.execute({ sql: `INSERT OR REPLACE INTO ${tmp} (${commonColsList}) SELECT ${commonColsList} FROM live_links`, args: [] });
    } catch (e) {
      console.error("[migrate] copy-to-temp failed:", e && (e.message || e));
      throw new Error("Schema migration failed during copy: " + (e && e.message));
    }
    // drop old and rename
    try {
      await db.execute({ sql: `DROP TABLE IF EXISTS live_links`, args: [] });
      await db.execute({ sql: `ALTER TABLE ${tmp} RENAME TO live_links`, args: [] });
      console.log("[migrate] fallback migration complete");
    } catch (e) {
      console.error("[migrate] rename/drop failed:", e && (e.message || e));
      throw new Error("Schema migration failed during rename: " + (e && e.message));
    }
  } else {
    console.log("[migrate] ALTER TABLE completed successfully for all missing columns.");
  }
}


export async function getLastUpdate(db) {
  const rs = await db.execute({ sql: "SELECT value FROM meta WHERE key = 'last_update'", args: [] });
  if (!rs.rows || rs.rows.length === 0) return null;
  return rs.rows[0].value;
}

export async function setLastUpdate(db, value) {
  await db.execute({ sql: "INSERT INTO meta (key, value) VALUES ('last_update', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [value] });
}

function isoNow(){ return new Date().toISOString(); }

async function probeForM3u8(url) {
  try {
    if (url.includes(".m3u8")) return url;
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    const ct = head.headers.get("content-type") || "";
    if (ct.includes("mpegurl") || ct.includes("application/vnd.apple.mpegurl")) return url;
  } catch (e) {
    // ignore
  }
  return null;
}

async function resolveYouTubeLiveUrl(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    const final = res.url || url;
    const m = final.match(/watch\?v=([A-Za-z0-9_-]{11})/);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    const html = await res.text();
    const mh = html.match(/watch\?v=([A-Za-z0-9_-]{11})/);
    if (mh) return `https://www.youtube.com/watch?v=${mh[1]}`;
  } catch (e) {
    // ignore
  }
  return null;
}

export async function extractAndRewrite(channels) {
  const db = await createDb();
  await ensureSchema(db);

  // Check last update
  const last = await getLastUpdate(db);
  const now = isoNow();
  if (last) {
    const elapsed = Date.parse(now) - Date.parse(last);
    if (elapsed < SIX_HOURS_MS) {
      return { skipped: true, last, elapsed_ms: elapsed };
    }
  }

  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY || "1", 10));
  const limit = pLimit(concurrency);

  const tasks = channels.map(ch => limit(async () => {
    const name = ch.name || ch.title || ("ch_"+Math.random().toString(36).slice(2,8));
    const rawUrl = ch.url;
    if (!rawUrl) return { name, ok:false, reason:"missing-url" };

    // If youtube-like, try to resolve live watch URL
    try {
      const u = new URL(rawUrl);
      if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be") || rawUrl.includes("/@") || rawUrl.includes("/user/")) {
        const watch = await resolveYouTubeLiveUrl(rawUrl);
        if (watch) {
          try {
            const info = await ytdl.getInfo(watch, { requestOptions: { headers: { 'user-agent': 'Mozilla/5.0' } } });
            const fmts = info.formats || [];
            const hls = fmts.find(f => f.isHLS || (f.mimeType && (f.mimeType.includes('mpegurl') || f.mimeType.includes('vnd.apple.mpegurl'))));
            if (hls && hls.url) {
              return { name, ok:true, url:hls.url, extractor:"ytdl-core", quality: hls.qualityLabel || null };
            }
          } catch (e) {
            console.log("[extract] ytdl failed for", rawUrl, e && e.message);
          }
        }
      }
    } catch (e) {
      // not a valid URL or parse error
    }

    // Generic probe
    try {
      const probed = await probeForM3u8(rawUrl);
      if (probed) return { name, ok:true, url:probed, extractor:"probe", quality:null };
    } catch (e) {}

    return { name, ok:false, reason:"no-m3u8" };
  })) ;

  const results = await Promise.all(tasks);
  const ok = results.filter(r => r.ok && r.url);

  // Rewrite table: delete all then insert fresh
  await db.execute("DELETE FROM live_links");
  let updated = 0;
  for (const r of ok) {
    await db.execute({ sql: "INSERT INTO live_links (name, url, extractor, quality, last_updated) VALUES (?, ?, ?, ?, ?)", args: [r.name, r.url, r.extractor, r.quality, isoNow()] });
    updated++;
  }
  await setLastUpdate(db, isoNow());
  return { skipped:false, processed: channels.length, updated, failed: results.length - ok.length };
}
