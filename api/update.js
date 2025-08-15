
import { updateLinks } from "../utils/updateLinks.js";
import { createClient } from "@libsql/client";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function jsonRes(res, code, obj){
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res){
  const id = Math.random().toString(36).slice(2,8);
  const log = (...a)=>console.log('[api/update]', id, ...a);
  const start = Date.now();
  try{
    const headerKey = req.headers['x-cron-key'];
    const qSecret = new URL(req.url, 'http://localhost').searchParams.get('secret');
    const secret = process.env.CRON_SECRET;
    if(!secret){ log('CRON_SECRET missing'); return jsonRes(res,500,{ok:false,error:'CRON_SECRET not configured'}); }
    if(!(headerKey===secret || qSecret===secret)){ log('unauthorized'); return jsonRes(res,403,{ok:false,error:'unauthorized'}); }

    const tursoRaw = process.env.TURSO_URL;
    const tursoToken = process.env.TURSO_TOKEN;
    if(!tursoRaw || !tursoToken){ log('TURSO_URL/TURSO_TOKEN missing'); return jsonRes(res,500,{ok:false,error:'TURSO_URL/TURSO_TOKEN not configured'}); }
    const tursoUrl = tursoRaw.startsWith('libsql://') ? tursoRaw.replace('libsql://','https://') : tursoRaw;
    const db = createClient({ url: tursoUrl, authToken: tursoToken });

    await db.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const rs = await db.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: ["last_update"] });
    const last = rs.rows && rs.rows.length ? rs.rows[0].value : null;
    if(last){
      const elapsed = Date.now() - Date.parse(last);
      if(elapsed < SIX_HOURS_MS){ log('skip - last update', last, 'elapsed_ms', elapsed); return jsonRes(res,200,{ok:true,skipped:true,last_update:last}); }
    }

    log('running updateLinks');
    const result = await updateLinks({ tursoUrl: tursoRaw, tursoToken: tursoToken, channelsUrl: process.env.CHANNELS_JSON_URL, logger: console });
    const duration = Date.now()-start;
    log('done', result, 'duration_ms', duration);
    return jsonRes(res,200,{ok:true,result,duration_ms:duration});
  }catch(err){
    console.error('[api/update ERROR]', err && (err.stack||err.message||err));
    return jsonRes(res,500,{ok:false,error:String(err && (err.message || err))});
  }
}
