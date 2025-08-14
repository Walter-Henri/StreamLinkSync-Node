
import { request } from "undici";
import ytdl from "ytdl-core";

const VERCEL_TIMEOUT = 45_000;
const EXTRACTION_TIMEOUT = 12_000;

function withinTimeout(start, budget) {
  return Date.now() - start < budget;
}

async function probeM3U8(url) {
  try {
    const { statusCode, headers } = await request(url, { method: "HEAD", maxRedirections: 2 });
    if (statusCode >= 200 && statusCode < 400) {
      const ct = headers["content-type"] || "";
      if (ct.includes("mpegurl") || url.includes(".m3u8")) return { ok: true, quality: "unknown" };
    }
  } catch {}
  return { ok: false };
}

async function extractYouTube(url) {
  try {
    const info = await ytdl.getInfo(url, { lang: "pt-BR" });
    const fmts = info.formats || [];
    const hls = fmts.find(f => (f.isHLS || f.mimeType?.includes("application/vnd.apple.mpegurl")) && f.url);
    if (hls?.url) {
      return { url: hls.url, extractor: "ytdl-core", quality: hls.qualityLabel || String(hls.bitrate || "") };
    }
  } catch {}
  return null;
}

export async function extractLink(channel, startTs) {
  const name = channel.name;
  const url = String(channel.url);

  const result = { name, original_url: url, url: null, extractor: "failed", quality: "unknown" };

  if (!withinTimeout(startTs, VERCEL_TIMEOUT - 15_000)) {
    throw new Error("Tempo insuficiente para extração");
  }

  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
      const yt = await extractYouTube(url);
      if (yt) return { name, original_url: url, url: yt.url, extractor: yt.extractor, quality: yt.quality };
    }
  } catch {}

  const probe = await probeM3U8(url);
  if (probe.ok) {
    return { name, original_url: url, url, extractor: "probe", quality: probe.quality || "unknown" };
  }

  return result;
}
