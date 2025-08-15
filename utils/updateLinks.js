import ytdl from 'ytdl-core';
import pLimit from 'p-limit';

export default async function updateLinks(db, channelsUrl, options = {}) {
  const concurrency = options.concurrency || 6;
  const limit = pLimit(concurrency);

  async function probeUrl(url) {
    try {
      if (url.includes('.m3u8')) return { ok: true, url };
      const head = await fetch(url, { method: 'HEAD', redirect: 'follow', cache: 'no-store' });
      if (!head.ok) return { ok: false };
      const ct = head.headers.get('content-type') || '';
      if (ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl')) return { ok: true, url };
      return { ok: false };
    } catch (err) { return { ok:false, error:String(err) }; }
  }

  async function extractForChannel(ch) {
    const name = ch.name || ch.title || ch.id || ('channel_' + Math.random().toString(36).slice(2,8));
    const url = ch.url || ch.watchUrl || ch.link;
    if (!url) return { name, ok:false, reason:'missing-url' };
    try {
      try {
        const u = new URL(url);
        if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
          const info = await ytdl.getInfo(url);
          const fmts = info.formats || [];
          const hls = fmts.find(f => f.isHLS || (f.mimeType && (f.mimeType.includes('mpegurl') || f.mimeType.includes('vnd.apple.mpegurl'))));
          if (hls && hls.url) return { name, ok:true, m3u8:hls.url, extractor:'ytdl-core', quality: hls.qualityLabel || null };
        }
      } catch (e) {}
      const prob = await probeUrl(url);
      if (prob.ok) return { name, ok:true, m3u8:prob.url, extractor:'probe', quality:null };
      return { name, ok:false, reason:'no-m3u8' };
    } catch (err) { return { name, ok:false, reason:String(err) }; }
  }

  const res = await fetch(channelsUrl, { cache:'no-store' });
  if (!res.ok) throw new Error('Failed to fetch channels.json - HTTP ' + res.status);
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch (e) { throw new Error('channels.json invalid JSON: ' + e.message); }
  const channels = Array.isArray(parsed) ? parsed : (parsed.channels || []);
  if (!channels.length) throw new Error('channels list empty');

  const tasks = channels.map(ch => limit(() => extractForChannel(ch)));
  const results = await Promise.all(tasks);

  await db.execute(`CREATE TABLE IF NOT EXISTS links (
    name TEXT PRIMARY KEY,
    m3u8_url TEXT,
    extractor TEXT,
    quality TEXT,
    last_updated TEXT
  )`);

  let updated = 0;
  const details = [];
  for (const r of results) {
    if (r.ok && r.m3u8) {
      try {
        await db.execute({
          sql: `INSERT INTO links (name, m3u8_url, extractor, quality, last_updated)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET m3u8_url = excluded.m3u8_url, extractor = excluded.extractor, quality = excluded.quality, last_updated = excluded.last_updated`,
          args: [r.name, r.m3u8, r.extractor, r.quality, new Date().toISOString()]
        });
        updated++;
        details.push({ name: r.name, ok: true });
      } catch (err) {
        details.push({ name: r.name, ok:false, error:String(err) });
      }
    } else {
      details.push({ name: r.name, ok:false, reason:r.reason || 'unknown' });
    }
  }

  return { processed: results.length, updated, failed: results.length - updated, details };
}
