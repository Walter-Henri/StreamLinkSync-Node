
import { json } from "./_util.js";
import handlerSync from "./sync.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  // Dispara a sincronização (delegando ao endpoint de sync)
  req.method = "POST";
  return handlerSync(req, res);
}
