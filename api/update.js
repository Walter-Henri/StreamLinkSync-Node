
import { extractAndRewrite } from "../utils/updateLinks.js";

const CHANNELS_JSON_URL = process.env.CHANNELS_JSON_URL || "https://drive.google.com/uc?export=download&id=1y_baDMf3VVYrksEhbE2YQZ5td0REd89p";

async function resetCronIfConfigured() {
  const key = process.env.CRON_API_KEY;
  const jobId = process.env.CRON_JOB_ID;
  if (!key || !jobId) return null;
  try {
    const res = await fetch(`https://api.cron-job.org/v1/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type":"application/json" },
      body: JSON.stringify({ job: { enabled: true } })
    });
    const j = await res.json();
    return { ok: res.ok, status: res.status, body: j };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
}

export default async function handler(req, res) {
  const start = Date.now();
  const id = Math.random().toString(36).slice(2,8);
  const log = (...a) => console.log(`[update ${id}]`, ...a);

  try {
    log("Fetching channels from:", CHANNELS_JSON_URL);
    const chRes = await fetch(CHANNELS_JSON_URL, { cache: "no-store" });
    if (!chRes.ok) throw new Error("Failed to download channels.json: HTTP " + chRes.status);
    const text = await chRes.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error("channels.json invalid: " + e.message); }
    const channels = Array.isArray(parsed) ? parsed : (parsed.channels || []);
    if (!channels.length) throw new Error("channels.json contains no channels");
    log("Channels count:", channels.length);
    const result = await extractAndRewrite(channels);
    log("Result:", result);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:true, ...result, duration_ms: Date.now() - start }));
  } catch (err) {
    console.error("[update ERROR]", err && (err.stack || err.message || err));
    const reset = await resetCronIfConfigured();
    if (reset) console.log("[cron reset attempt]", reset);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:false, error: String(err && (err.message || err)), cron_reset: reset }));
  }
}
