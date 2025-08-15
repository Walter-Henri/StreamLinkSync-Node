// /lib/updateLinks.js
import { createClient } from "@libsql/client";
import fetch from "node-fetch";
import { spawn } from "child_process";

/**
 * Função para extrair o link M3U8 mais recente de uma live do YouTube.
 * Utiliza o `streamlink` CLI, que é mais leve que `ytdl-core` e funciona bem na Vercel.
 * 
 * @param {string} youtubeUrl - URL da live ou canal do YouTube
 * @returns {Promise<string|null>} - URL do stream M3U8 ou null
 */
async function extractM3U8(youtubeUrl) {
  return new Promise((resolve, reject) => {
    const process = spawn("streamlink", [youtubeUrl, "best", "--stream-url"]);

    let output = "";
    let errorOutput = "";

    process.stdout.on("data", (data) => {
      output += data.toString();
    });

    process.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        console.error(`❌ Erro ao extrair ${youtubeUrl}:`, errorOutput);
        resolve(null);
      }
    });
  });
}

/**
 * Atualiza os links M3U8 no banco de dados Turso (tabela `live_links`)
 */
export async function updateLinks() {
  console.log("🚀 Iniciando atualização de links M3U8...");

  const db = createClient({
    url: process.env.TURSO_DB_URL,
    authToken: process.env.TURSO_DB_TOKEN
  });

  try {
    // Obtém todas as lives registradas
    const { rows: lives } = await db.execute("SELECT id, name, url FROM live_links");

    if (!lives || lives.length === 0) {
      console.warn("⚠️ Nenhuma live encontrada na tabela live_links.");
      return { ok: false, error: "Nenhuma live encontrada" };
    }

    console.log(`📡 Encontradas ${lives.length} lives. Iniciando extração...`);

    for (const live of lives) {
      console.log(`🎯 Processando: ${live.name} (${live.url})`);

      const m3u8Url = await extractM3U8(live.url);

      if (m3u8Url) {
        await db.execute({
          sql: "UPDATE live_links SET url = ? WHERE id = ?",
          args: [m3u8Url, live.id]
        });
        console.log(`✅ Link atualizado para ${live.name}`);
      } else {
        console.warn(`⚠️ Não foi possível extrair link para ${live.name}`);
      }
    }

    console.log("🎉 Atualização concluída com sucesso!");
    return { ok: true };

  } catch (err) {
    console.error("❌ Erro na atualização de links:", err);
    return { ok: false, error: err.message };
  } finally {
    await db.close();
  }
}
