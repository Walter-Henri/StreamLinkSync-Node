
import { ensureSchema, getDb } from "../../lib/db.js";
import { appendLog } from "../../lib/logs.js";
import { extractLink } from "../../lib/extract.js";
import pLimit from "p-limit";
import { json } from "../_util.js";
import crypto from "crypto";
import { request } from "undici";

const MAX_CONCURRENT = 10;

async function loadChannels() {
  const url = process.env.CHANNELS_JSON_URL;
  if (!url) throw new Error("CHANNELS_JSON_URL não configurada");
  const res = await request(url, { method: "GET", maxRedirections: 2 });
  if (res.statusCode !== 200) throw new Error(`Falha ao baixar channels.json: ${res.statusCode}`);
  const body = await res.body.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error("JSON inválido em CHANNELS_JSON_URL"); }
  if (!Array.isArray(parsed.channels)) throw new Error("Formato inválido de channels.json (esperado { channels: [...] })");
  return parsed.channels;
}

async function updateDatabase(results, logs) {
  const db = await ensureSchema();
  await db.execute("BEGIN");
  try {
    for (const r of results) {
      await db.execute({
        sql: `INSERT INTO live_links(name, url, extractor, quality, status) VALUES(?,?,?,?,?)
              ON CONFLICT(name) DO UPDATE SET url=excluded.url, extractor=excluded.extractor, quality=excluded.quality, last_updated=CURRENT_TIMESTAMP, status=excluded.status`,
        args: [r.name, r.url || "", r.extractor || "unknown", r.quality || "unknown", r.url ? "active" : "failed"]
      });
    }
    await db.execute("COMMIT");
    logs.push(await appendLog(logs.syncId, "SUCCESS", `Banco atualizado: ${results.filter(r => r.url).length} links salvos`));
  } catch (e) {
    await db.execute("ROLLBACK");
    logs.push(await appendLog(logs.syncId, "ERROR", `Erro ao atualizar banco: ${e.message}`));
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });

  const syncId = crypto.randomUUID();
  const start = Date.now();
  const logs = [];
  logs.syncId = syncId;

  try {
    await appendLog(syncId, "INFO", "Iniciando sincronização ultra-rápida");
    const channels = await loadChannels();
    await appendLog(syncId, "INFO", `Canais carregados: ${channels.length}`);

    const limit = pLimit(MAX_CONCURRENT);
    const tasks = channels.map(ch => limit(() => extractLink(ch, start)));
    const settled = await Promise.allSettled(tasks);
    const results = settled.map(s => s.status === "fulfilled" ? s.value : { name: "unknown", original_url: "", url: null, extractor: "failed", quality: "unknown" });

    await updateDatabase(results, logs);

    await appendLog(syncId, "SUCCESS", "Sincronização concluída");
    return json(res, 200, { sync_id: syncId });
  } catch (e) {
    await appendLog(syncId, "ERROR", `Falha: ${e.message}`);
    return json(res, 500, { sync_id: syncId, error: e.message });
  }
}
