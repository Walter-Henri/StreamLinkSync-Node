
import { ensureSchema } from "../../lib/db.js";
import { json } from "../_util.js";

export default async function handler(req, res) {
  const { live_name } = req.query;
  const db = await ensureSchema();
  const result = await db.execute({ sql: "SELECT name, url, extractor, quality, last_updated, status FROM live_links WHERE name = ?", args: [live_name] });
  const row = result.rows[0];
  if (!row) return json(res, 404, { error: "Live não encontrada" });
  return json(res, 200, row);
}
