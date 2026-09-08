#!/usr/bin/env node
/**
 * Local development server.
 *
 *   node server.js        →  http://localhost:3000
 *
 * Serves the HTML/CSS/JS sitting next to this file, and routes /api/*
 * to the same handlers Netlify will run in production. Nothing here ships
 * to Netlify — it exists so the project runs in VS Code with one command
 * and no CLI to install or log into.
 *
 * Because it calls the exact same exports.handler functions, behaviour
 * matches production. If it works here it works deployed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* Load .env without a dependency — one KEY=value per line, # for comments. */
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) {
    console.warn('No .env found. Copy .env.example to .env and fill it in.\n');
    return;
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
})();

const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

/* Never expose the backend or your secrets over the static server. */
const BLOCKED = new Set([
  '.env', 'core.js', 'matcher.js', 'seed.js', 'create-admin.js',
  'server.js', 'package.json', 'package-lock.json', 'netlify.toml',
]);

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw || null));
  });

/**
 * Functions are required lazily and cached by name, so a syntax error in
 * one endpoint doesn't stop the whole server from booting.
 */
function loadFunction(name) {
  const file = path.join(__dirname, 'functions', `${name}.js`);
  if (!fs.existsSync(file)) return null;
  // Clear the cache each request so edits show up without a restart.
  delete require.cache[require.resolve(file)];
  return require(file);
}

async function handleApi(req, res, url) {
  // /api/products/123/stock  ->  fn "products", path "/products/123/stock"
  const rest = url.pathname.replace(/^\/api\/?/, '');
  const name = rest.split('/')[0];

  const mod = name && loadFunction(name);
  if (!mod || typeof mod.handler !== 'function') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: `No API route named "${name}".` }));
  }

  const event = {
    httpMethod: req.method,
    path: '/' + rest,
    rawQuery: url.search.replace(/^\?/, ''),
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: await readBody(req),
  };

  try {
    const result = await mod.handler(event, { callbackWaitsForEmptyEventLoop: true });
    res.writeHead(result.statusCode, result.headers || { 'Content-Type': 'application/json' });
    res.end(result.body || '');
  } catch (err) {
    console.error(`[${name}]`, err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Function threw. See the terminal.' }));
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  // Dotfiles first: path.extname('.env') is '', so the rule below would
  // otherwise turn a request for .env into a lookup for .env.html and
  // answer 404 instead of refusing outright.
  if (path.basename(rel).startsWith('.')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  if (!path.extname(rel)) rel += '.html';        // /shop  ->  shop.html

  const base = path.basename(rel);
  const full = path.join(__dirname, rel);

  // Block path traversal and anything on the deny list.
  if (!full.startsWith(__dirname) || BLOCKED.has(base) || rel.startsWith('functions')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        `<pre style="font:14px/1.6 monospace;padding:40px">404 — ${rel} not found.
Files available: ${fs.readdirSync(__dirname).filter((f) => f.endsWith('.html')).join(', ')}</pre>`
      );
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream',
      'Cache-Control': 'no-store',              // always see your latest edit
    });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api')) return handleApi(req, res, url);
  serveStatic(req, res, url);
}).listen(PORT, () => {
  const db = process.env.MONGODB_URI ? 'connected via MONGODB_URI' : 'NOT SET — check .env';
  console.log(`
  Scent Nest running
  http://localhost:${PORT}

  Database: ${db}
  Stop with Ctrl+C. Edits to functions/ reload on the next request.
`);
});
