// خادم تجربة محلي: الواجهة + خادم المكتب ببيانات وهمية (بدون Cloudflare)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fakeD1 } from "./d1.mjs";
import worker from "../src/worker.js";
const env = { DB: fakeD1(), OFFICE_PASSWORD: "test-password", AGENT_TOKEN: "dev-agent",
  ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; const f = p === "/" ? "index.html" : p.slice(1);
    try { const b = await readFile(new URL("../public/" + f, import.meta.url)); return new Response(b, { headers: { "Content-Type": f.endsWith(".css") ? "text/css" : f.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" } }); } catch { return new Response("nf", { status: 404 }); } } },
  fetch: async () => Response.json({ ok: true }) };
const port = Number(process.env.PORT || 8788);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log("http://localhost:" + port));
