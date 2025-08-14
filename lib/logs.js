
import { ensureSchema } from "./db.js";

export async function appendLog(syncId, type, message) {
  const icon = { INFO: "ℹ", SUCCESS: "✓", ERROR: "✗", WARNING: "⚠" }[type] || "ℹ";
  const ts = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour12: false });
  const db = await ensureSchema();
  await db.execute({
    sql: "INSERT INTO sync_logs(sync_id, timestamp, type, icon, message) VALUES(?,?,?,?,?)",
    args: [syncId, ts, type, icon, message]
  });
  return { timestamp: ts, icon, type, message };
}

export async function readLogs(syncId) {
  const db = await ensureSchema();
  const res = await db.execute({
    sql: "SELECT timestamp, icon, type, message FROM sync_logs WHERE sync_id = ? ORDER BY rowid ASC",
    args: [syncId]
  });
  return res.rows.map(r => ({
    timestamp: r.timestamp,
    icon: r.icon,
    type: r.type,
    message: r.message
  }));
}
