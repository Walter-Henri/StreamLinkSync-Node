
import { json } from "./_util.js";

let hbCount = 0;
let lastHeartbeat = null;

export default async function handler(req, res) {
  hbCount += 1;
  lastHeartbeat = new Date().toISOString();
  return json(res, 200, { status: "ok", last_heartbeat: lastHeartbeat, heartbeat_count: hbCount });
}
