
export default async function handler(req, res) {
  res.statusCode = 302;
  res.setHeader("Location", "/");
  res.end();
}
