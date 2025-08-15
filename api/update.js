// api/update.js
import { extractAndRewrite } from "../utils/updateLinks.js";

const DEFAULT_CHANNELS_JSON_URL =
  process.env.CHANNELS_JSON_URL ||
  "https://drive.google.com/uc?export=download&id=1y_baDMf3VVYrksEhbE2YQZ5td0REd89p";

// tempo máximo para baixar channels.json (ms)
const CHANNELS_FETCH_TIMEOUT_MS = 120000;

async function resetCronIfConfigured() {
  const key = process.env.CRON_API_KEY;
  const jobId = process.env.CRON_JOB_ID;
  if (!key || !jobId) return null;
  try {
    const res = await fetch(`https://api.cron-job.org/v1/jobs/${jobId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ job: { enabled: true } }),
    });

    // ler corpo com segurança (pode ser vazio)
    let bodyText = null;
    try {
      bodyText = await res.text();
    } catch (e) {
      bodyText = null;
    }
    let bodyJson = null;
    if (bodyText && bodyText.trim().length) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch (e) {
        bodyJson = bodyText;
      }
    }
    return { ok: res.ok, status: res.status, body: bodyJson };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function parseChannelsUrlFromReq(req) {
  try {
    // req.url é path + query. Precisamos de host para construir URL; use header host quando disponível.
    const base = `https://${req.headers && req.headers.host ? req.headers.host : "example.com"}`;
    const u = new URL(req.url || "/", base);
    const override = u.searchParams.get("channelsUrl");
    return override || null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  const start = Date.now();
  const id = Math.random().toString(36).slice(2, 8);
  const log = (...a) => console.log(`[update ${id}]`, ...a);

  // Allow only GET or POST (safe)
  if (!["GET", "POST"].includes(req.method)) {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  let resetAttempt = null;

  try {
    const overrideChannelsUrl = parseChannelsUrlFromReq(req);
    const channelsUrl = overrideChannelsUrl || process.env.CHANNELS_JSON_URL || DEFAULT_CHANNELS_JSON_URL;

    log("Fetching channels from:", channelsUrl);

    // fetch with timeout using AbortController
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHANNELS_FETCH_TIMEOUT_MS);

    let chRes;
    try {
      chRes = await fetch(channelsUrl, { cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!chRes || !chRes.ok) {
      const code = chRes ? chRes.status : "NO_RESPONSE";
      throw new Error("Failed to download channels.json: HTTP " + code);
    }

    const text = await chRes.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error("channels.json invalid: " + (e && e.message));
    }

    const channels = Array.isArray(parsed) ? parsed : parsed.channels || [];
    if (!channels || !channels.length) {
      throw new Error("channels.json contains no channels");
    }

    // validate channels entries and log issues
    const bad = [];
    const valid = [];
    for (const c of channels) {
      if (!c || !c.url) {
        bad.push(c);
      } else {
        valid.push({ name: c.name || c.title || null, url: c.url });
      }
    }
    if (bad.length) log("channels.json includes invalid entries (missing url):", bad.length);

    log("Channels count (valid):", valid.length, " (ignored invalid):", bad.length);

    // call extractAndRewrite (it enforces 6h gate internally)
    const result = await extractAndRewrite(valid);

    log("Result:", result);

    // respond 200 always when handler executed; include result for debugging
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, fetched_channels: valid.length, fetched_invalid: bad.length, ...result, duration_ms: Date.now() - start }));
    return;
  } catch (err) {
    console.error("[update ERROR]", err && (err.stack || err.message || err));
    // attempt cron reset, but don't let it throw
    try {
      resetAttempt = await resetCronIfConfigured();
      log && log("[cron reset attempt]", resetAttempt);
    } catch (e) {
      resetAttempt = { ok: false, error: String(e) };
    }

    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: String(err && (err.message || err)),
        cron_reset: resetAttempt,
        duration_ms: Date.now() - start,
      })
    );
    return;
  }
}
