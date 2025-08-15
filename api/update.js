import { createClient } from "@libsql/client";
import updateLinks from "../utils/updateLinks.js";

const DEFAULT_CHANNELS_JSON_URL = "https://drive.google.com/uc?export=download&id=1y_baDMf3VVYrksEhbE2YQZ5td0REd89p";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
function iso(){return new Date().toISOString();}

async function ensureMetaTable(db){
  await db.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
}

async function getLastUpdate(db){
  const r = await db.execute({ sql: "SELECT value FROM meta WHERE key = 'last_update'", args: [] });
  if (!r.rows || r.rows.length === 0) return null;
  return r.rows[0].value;
}

async function setLastUpdate(db,val){
  await db.execute({ sql: "INSERT INTO meta (key, value) VALUES ('last_update', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [val] });
}

export default async function handler(req,res){
  const start = Date.now();
  const ctxId = Math.random().toString(36).slice(2,8);
  const log = (...a) => console.log(`[update ${ctxId}]`, ...a);
  try{
    const headerKey = req.headers['x-cron-key'];
    const qSecret = new URL(req.url,'http://localhost').searchParams.get('secret');
    const secret = process.env.CRON_SECRET;
    if(!secret){ log('CRON_SECRET not configured'); res.statusCode=500; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:false,error:'CRON_SECRET not configured'})); return; }
    if(!(headerKey===secret || qSecret===secret)){ log('Unauthorized attempt'); res.statusCode=403; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:false,error:'Unauthorized'})); return; }

    const rawUrl = process.env.TURSO_URL;
    const token = process.env.TURSO_TOKEN;
    if(!rawUrl || !token){ log('TURSO_URL/TURSO_TOKEN not configured'); res.statusCode=500; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:false,error:'TURSO_URL/TURSO_TOKEN not configured'})); return; }
    const dbUrl = rawUrl.startsWith('libsql://') ? rawUrl.replace('libsql://','https://') : rawUrl;
    const db = createClient({ url: dbUrl, authToken: token });

    await ensureMetaTable(db);
    const last = await getLastUpdate(db);
    if(last){
      const elapsed = Date.now() - Date.parse(last);
      if(elapsed < SIX_HOURS_MS){
        log('Skipping update: last_update', last, 'elapsed_ms', elapsed);
        res.statusCode=200; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:true,skipped:true,last_update:last})); return;
      }
    }
    log('Proceeding to perform update; last_update:', last);

    const channelsUrl = process.env.CHANNELS_JSON_URL || DEFAULT_CHANNELS_JSON_URL;
    log('Using channels JSON:', channelsUrl);

    const stats = await updateLinks(db, channelsUrl, { concurrency: 6 });
    log('updateLinks result', stats);

    if(stats.updated > 0){ await setLastUpdate(db, iso()); log('Saved last_update to DB'); } else { log('No links updated; last_update not changed'); }

    const duration = Date.now() - start;
    res.statusCode=200; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:true,stats,duration_ms:duration}));
  }catch(err){
    console.error('[update ERROR]', err && (err.stack || err.message || err));
    res.statusCode=500; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:false,error:String(err && (err.message || err))}));
  }
}
