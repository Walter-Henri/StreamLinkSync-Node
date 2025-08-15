import { createClient } from "@libsql/client";
export default async function handler(req,res){
  try{
    const raw = process.env.TURSO_URL; const token = process.env.TURSO_TOKEN;
    if(!raw||!token){ res.statusCode=500; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:false,error:'TURSO_URL/TURSO_TOKEN not configured'})); return; }
    const dbUrl = raw.startsWith('libsql://') ? raw.replace('libsql://','https://') : raw;
    const db = createClient({ url: dbUrl, authToken: token });
    await db.execute(`CREATE TABLE IF NOT EXISTS links ( name TEXT PRIMARY KEY, m3u8_url TEXT, extractor TEXT, quality TEXT, last_updated TEXT )`);
    const rs = await db.execute("SELECT name, m3u8_url, extractor, quality, last_updated FROM links ORDER BY name");
    const rows = rs.rows || [];
    res.statusCode=200; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify(rows));
  }catch(err){ console.error('[list ERROR]', err && (err.stack||err.message||err)); res.statusCode=500; res.setHeader('content-type','application/json; charset=utf-8'); res.end(JSON.stringify({ok:false,error:String(err && (err.message||err))})); }
}