
import { readLogs } from "../../../lib/logs.js";
import { json } from "../../_util.js";

export default async function handler(req, res) {
  const { sync_id } = req.query;
  if (!sync_id) return json(res, 400, { error: "sync_id ausente" });
  const logs = await readLogs(sync_id);
  if (!logs.length) return json(res, 404, { error: "Logs não encontrados" });
  return json(res, 200, logs);
}
