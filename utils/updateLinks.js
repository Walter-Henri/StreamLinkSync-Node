// utils/updateLinks.js
// Reescrito para ser robusto: cria/migra schema, trata meta ausente,
// extrai m3u8 de canais do YouTube (resolvendo /@channel/live),
// probe HEAD fallback, escreve/regrava tabela live_links.
// Dependências: @libsql/client, ytdl-core, p-limit

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

/**
 * Cria tabela live_links e meta se necessário.
 * Detecta colunas faltantes e tenta ALTER TABLE ADD COLUMN.
 * Se ALTER falhar, faz migração segura (cria tabela temporária e copia dados).
 */
export async function ensureSchema(db) {
  // esquema desejado
  const desiredCols = [
    { name: "name", type: "TEXT" },
    { name: "url", type: "TEXT" },
    { name: "extractor", type: "TEXT" },
    { name: "quality", type: "TEXT" },
    { name: "last_updated", type: "TEXT" }
  ];

  // cria tabelas básicas se não existem
  await db.execute(`
    CREATE TABLE IF NOT EXISTS live_links (
      name TEXT PRIMARY KEY,
      url TEXT,
      extractor TEXT,
      quality TEXT,
      last_updated TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // obtém colunas existentes com PRAGMA (tenta, mas protege contra falha)
  let infoRows = [];
  try {
    const rs = await db.execute({ sql: "PRAGMA table_info('live_links')", args: [] });
    infoRows = rs.rows || [];
  } catch (e) {
    console.warn("[ensureSchema] PRAGMA falhou:", e && (e.message || e));
    infoRows = [];
  }

  const existing = new Set(infoRows.map(r => r.name));
  const missing = desiredCols.filter(c => !existing.has(c.name));
  if (missing.length === 0) {
    console.log("[ensureSchema] live_links schema up-to-date");
    return;
  }

  console.log("[ensureSchema] colunas faltando:", missing.map(m => m.name));

  const alterFailed = [];
  for (const col of missing) {
    try {
      const sql = `ALTER TABLE live_links ADD COLUMN ${col.name} ${col.type}`;
      await db.execute({ sql, args: [] });
      console.log("[ensureSchema] adicionada coluna:", col.name);
    } catch (e) {
      console.error("[ensureSchema] ALTER TABLE falhou para", col.name, e && (e.message || e));
      alterFailed.push(col.name);
    }
  }

  // fallback: migração segura se ALTER TABLE falhou
  if (alterFailed.length > 0) {
    console.log("[ensureSchema] realizando migração fallback para:", alterFailed);
    const tmp = "live_links_new";
    await db.execute(`
      CREATE TABLE IF NOT EXISTS ${tmp} (
        name TEXT PRIMARY KEY,
        url TEXT,
        extractor TEXT,
        quality TEXT,
        last_updated TEXT
      )
    `);

    // copia colunas compatíveis
    const commonCols = [...existing].filter(c => ["name","url","extractor","quality","last_updated"].includes(c));
    const commonColsList = commonCols.length ? commonCols.join(",") : "name";

    try {
      if (commonCols.length) {
        await db.execute({ sql: `INSERT OR REPLACE INTO ${tmp} (${commonColsList}) SELECT ${commonColsList} FROM live_links`, args: [] });
      }
      // drop old and rename
      await db.execute({ sql: `DROP TABLE IF EXISTS live_links`, args: [] });
      await db.execute({ sql: `ALTER TABLE ${tmp} RENAME TO live_links`, args: [] });
      console.log("[ensureSchema] migração fallback concluída");
    } catch (e) {
      console.error("[ensureSchema] migração fallback falhou:", e && (e.message || e));
      throw new Error("Schema migration failed: " + (e && e.message));
    }
  } else {
    console.log("[ensureSchema] ALTER TABLE completou com sucesso");
  }
}

/** Busca última atualização no meta.key = 'last_update'. Seguro contra ausência da tabela. */
export async function getLastUpdate(db) {
  try {
    const rs = await db.execute({ sql: "SELECT value FROM meta WHERE key = 'last_update'", args: [] });
    if (!rs.rows || rs.rows.length === 0) return null;
    return rs.rows[0].value;
  } catch (e) {
    console.warn("[getLastUpdate] SELECT falhou, assumindo null:", e && (e.message || e));
    return null;
  }
}

/** Define last_update na tabela meta */
export async function setLastUpdate(db, value) {
  try {
    await db.execute({
      sql: "INSERT INTO meta (key, value) VALUES ('last_update', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [value]
    });
  } catch (e) {
    console.error("[setLastUpdate] falha ao gravar meta:", e && (e.message || e));
  }
}

function isoNow() { return new Date().toISOString(); }

/** Probe HEAD para ver se o URL é um m3u8 (fallback). */
async function probeForM3u8(url) {
  try {
    if (!url) return null;
    if (url.includes(".m3u8")) return url;
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    const ct = (head.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("mpegurl") || ct.includes("vnd.apple.mpegurl")) return url;
  } catch (e) {
    // ignore probe errors (não falha todo o processo por causa disso)
    console.debug("[probeForM3u8] probe falhou para", url, e && (e.message || e));
  }
  return null;
}

/** Resolve URLs do tipo /@channel/live ou /user/... → final watch?v=... */
async function resolveYouTubeLiveUrl(url) {
  try {
    const resp = await fetch(url, { method: "GET", redirect: "follow" });
    const final = resp.url || url;
    const m = final.match(/watch\\?v=([A-Za-z0-9_-]{11})/);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    const html = await resp.text();
    const mh = html.match(/watch\\?v=([A-Za-z0-9_-]{11})/);
    if (mh) return `https://www.youtube.com/watch?v=${mh[1]}`;
  } catch (e) {
    console.debug("[resolveYouTubeLiveUrl] falha ao resolver", url, e && (e.message || e));
  }
  return null;
}

/**
 * Extrai links m3u8 a partir de um array de canais (cada item: { name, url }).
 * Reescreve completamente a tabela live_links (DELETE + INSERT) somente se a
 * janela de 6h foi ultrapassada.
 */
export async function extractAndRewrite(channels) {
  if (!Array.isArray(channels)) throw new Error("channels must be an array");

  const db = await createDb();
  await ensureSchema(db);

  // gate de 6h
  const last = await getLastUpdate(db);
  const now = isoNow();
  if (last) {
    const elapsed = Date.parse(now) - Date.parse(last);
    if (elapsed < SIX_HOURS_MS) {
      return { skipped: true, last, elapsed_ms: elapsed };
    }
  }

  // concurrency control (por padrão 1 para Vercel Hobby)
  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY || "1", 10));
  const limit = pLimit(concurrency);

  const tasks = channels.map(ch => limit(async () => {
    const name = (ch && (ch.name || ch.title)) || ("ch_" + Math.random().toString(36).slice(2,8));
    const rawUrl = ch && ch.url;
    if (!rawUrl) return { name, ok:false, reason:"missing-url" };

    // 1) Se for YouTube-like, tenta resolver para watch?v= e extrair via ytdl-core
    try {
      const u = new URL(rawUrl);
      if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be") || rawUrl.includes("/@") || rawUrl.includes("/user/")) {
        const watch = await resolveYouTubeLiveUrl(rawUrl);
        if (watch) {
          try {
            const info = await ytdl.getInfo(watch, { requestOptions: { headers: { 'user-agent': 'Mozilla/5.0' } } });
            const fmts = info.formats || [];
            const hls = fmts.find(f => f.isHLS || (f.mimeType && (f.mimeType.toLowerCase().includes('mpegurl') || f.mimeType.toLowerCase().includes('vnd.apple.mpegurl'))));
            if (hls && hls.url) {
              return { name, ok:true, url:hls.url, extractor:"ytdl-core", quality: hls.qualityLabel || null };
            }
          } catch (e) {
            console.debug("[extract] ytdl getInfo falhou para", rawUrl, e && (e.message || e));
          }
        }
      }
    } catch (e) {
      // não é URL válida — processa via probe abaixo
    }

    // 2) Probe genérico (HEAD)
    try {
      const probed = await probeForM3u8(rawUrl);
      if (probed) return { name, ok:true, url:probed, extractor:"probe", quality:null };
    } catch (e) {
      console.debug("[extract] probe falhou", rawUrl, e && (e.message || e));
    }

    return { name, ok:false, reason:"no-m3u8" };
  }));

  const results = await Promise.all(tasks);
  const ok = results.filter(r => r.ok && r.url);

  // Rewrite: delete all then insert fresh rows
  try {
    await db.execute("DELETE FROM live_links");
  } catch (e) {
    console.error("[extractAndRewrite] falha ao truncar live_links:", e && (e.message || e));
    throw e;
  }

  let updated = 0;
  for (const r of ok) {
    try {
      await db.execute({
        sql: "INSERT INTO live_links (name, url, extractor, quality, last_updated) VALUES (?, ?, ?, ?, ?)",
        args: [r.name, r.url, r.extractor, r.quality, isoNow()]
      });
      updated++;
    } catch (e) {
      console.error("[extractAndRewrite] falha ao inserir", r.name, e && (e.message || e));
    }
  }

  await setLastUpdate(db, isoNow());
  return { skipped:false, processed: channels.length, updated, failed: results.length - ok.length };
}
