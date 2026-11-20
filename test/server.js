// 本機測試伺服器：node test/server.js  → http://localhost:8080
// 用模擬的試算表跑 Code.gs，網頁直接連 /api
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeEnv } = require('./gas-shim');

const env = makeEnv();
env.sandbox.setup();
env.sandbox.createTestData();
const info = env.logs.filter(l => l.includes('PIN'));
fs.writeFileSync(path.join(__dirname, 'pins.txt'), info.join('\n'));
console.log(info.join('\n'));

const WEB = path.join(__dirname, '..', 'docs');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const out = env.sandbox.doPost({ postData: { contents: body } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out.getContent());
    });
    return;
  }
  if (req.url === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("window.CONFIG = { API_URL: '/api' };");
    return;
  }
  const p = path.join(WEB, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(WEB) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(8080, () => console.log('http://localhost:8080'));
