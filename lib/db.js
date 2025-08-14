
import { createClient } from "@libsql/client";

export function getDb() {
  const url = process.env.TURSO_URL?.replace("libsql://", "https://");
  const authToken = process.env.TURSO_TOKEN;
  if (!url || !authToken) {
    throw new Error("TURSO_URL/TURSO_TOKEN ausentes");
  }
  return createClient({ url, authToken });
}

export async function ensureSchema() {
  const db = getDb();
  await db.execute(`CREATE TABLE IF NOT EXISTS live_links (
    name TEXT PRIMARY KEY,
    url TEXT,
    extractor TEXT,
    quality TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'active'
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_logs (
    sync_id TEXT,
    timestamp TEXT,
    type TEXT,
    icon TEXT,
    message TEXT
  )`);
  return db;
}
