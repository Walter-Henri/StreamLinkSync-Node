
import { updateLinksFromChannels } from "../utils/updateLinks.js";

async function resetCronIfConfigured() {
  const key = process.env.CRON_API_KEY;
  const jobId = process.env.CRON_JOB_ID;
  if (!key || !jobId) return null;
  try {
    const res = await fetch(`https://api.cron-job.org/v1/jobs/${jobId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ job: { enabled: true } })
    });
    const j = await res.json();
    return { ok: res.ok, status: res.status, body: j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export default async function handler(req, res) {
  const start = Date.now();
  const id = Math.random().toString(36).slice(2,8);
  const log = (...a) => console.log(`[update ${id}]`, ...a);
  try {
    log("Request method:", req.method);
    const channelsUrl = process.env.CHANNELS_JSON_URL || undefined;
    log("Channels URL env present:", !!process.env.CHANNELS_JSON_URL);
    const result = await updateLinksFromChannels(channelsUrl);
    log("Update result:", result);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:true, ...result, duration_ms: Date.now() - start }));
  } catch (err) {
    console.error("[update ERROR]", err && (err.stack || err.message || err));
    // attempt cron reset
    const reset = await resetCronIfConfigured();
    if (reset) console.log("[cron reset attempt]", reset);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:false, error: String(err && (err.message || err)), cron_reset: reset }));
  }
}
