// Minimal SAM proxy: keeps your API token off the phone and on the server.
// nginx serves the PWA statically and forwards POST /api/sam here.
//
//   SAM_UPSTREAM_URL=https://your-sam-endpoint  SAM_TOKEN=xxxx  PORT=3001  node server/proxy.mjs
//
// The request body (multipart form with image + prompts + lat/lon) is
// streamed through untouched; only the Authorization header is added.
import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.PORT || 3001);
const UPSTREAM = process.env.SAM_UPSTREAM_URL || "";
const TOKEN = process.env.SAM_TOKEN || "";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: Boolean(UPSTREAM) }));
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/api/sam")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (!UPSTREAM) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "SAM_UPSTREAM_URL is not set on the proxy" }));
    return;
  }
  const target = new URL(UPSTREAM);
  const headers = { ...req.headers, host: target.host };
  delete headers["content-length"]; // re-chunked through the pipe
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  const client = target.protocol === "https:" ? https : http;
  const up = client.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: "POST",
      headers
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  up.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `upstream failed: ${e.message}` }));
  });
  req.pipe(up);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`microgeographies proxy on 127.0.0.1:${PORT} -> ${UPSTREAM || "(no upstream set)"}`);
});
