
import { updateLinksFromChannels } from "../utils/updateLinks.js";

export default async function handler(req, res) {
  const start = Date.now();
  const id = Math.random().toString(36).slice(2,8);
  const log = (...a) => console.log(`[update ${id}]`, ...a);
  try {
    log("Request method:", req.method);
    const channelsUrl = process.env.CHANNELS_JSON_URL || undefined;
    log("Channels URL (env present):", !!process.env.CHANNELS_JSON_URL);
    const result = await updateLinksFromChannels(channelsUrl);
    log("Result:", result);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:true, ...result, duration_ms: Date.now() - start }));
  } catch (err) {
    console.error("[update ERROR]", err && (err.stack || err.message || err));
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:false, error: String(err && (err.message || err)) }));
  }
}
