
import { ensureSchema } from "../../lib/db.js";

export default async function handler(req, res) {
  const { live_name } = req.query;
  const db = await ensureSchema();
  const result = await db.execute({ sql: "SELECT url FROM live_links WHERE name = ? AND status = 'active'", args: [live_name] });
  const row = result.rows[0];
  if (!row?.url) {
    res.statusCode = 404; res.end("Link não encontrado"); return;
  }
  res.statusCode = 302;
  res.setHeader("Location", row.url);
  res.end();
}
