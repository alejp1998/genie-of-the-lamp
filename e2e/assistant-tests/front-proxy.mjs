// Same-origin front for the assistant e2e stack: /agent-gateway/* goes to the
// gateway, everything else (HTTP and the /collab websocket) to Aldine. This is
// what Caddy does in the compose deployment; it exists so the suite needs no
// extra binaries.
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PROXY_PORT || 3262);
const ALDINE = new URL(process.env.ALDINE_URL || 'http://127.0.0.1:3260');
const GATEWAY = new URL(process.env.GATEWAY_URL || 'http://127.0.0.1:3261');
const target = (url) => (url.startsWith('/agent-gateway') ? GATEWAY : ALDINE);

const server = http.createServer((req, res) => {
  const t = target(req.url);
  const up = http.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${t.hostname}:${t.port}` } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
  res.on('close', () => up.destroy());
});

server.on('upgrade', (req, socket, head) => {
  const t = target(req.url);
  const up = net.connect(Number(t.port), t.hostname, () => {
    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`front proxy on :${PORT} → aldine ${ALDINE.host}, gateway ${GATEWAY.host}`));
