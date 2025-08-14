
import { ensureSchema } from "../../lib/db.js";
import { json } from "../_util.js";

export default async function handler(req, res) {
  const db = await ensureSchema();
  const result = await db.execute("SELECT name, url, extractor, quality, last_updated, status FROM live_links ORDER BY name ASC");
  return json(res, 200, result.rows);
}
