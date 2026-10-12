import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// server/index.mjs
// Folia-Termux 的本地网关：一个进程同时提供网页、AI 接口，并（默认）拉起网易云 API。
//
// 为什么需要它：Web 版前端把 AI 主题/歌词分词/歌词代理都发到同源的相对路径 `/api/*`，
// 而 Vercel/Cloudflare 的 serverless 在 Termux 里不存在。这里把 api/ 下那批处理器
// （Edge 形态 `(Request)=>Response` 与 Node 形态 `(req,res)`）挂到同一个 http 服务上，
// 并把 `/netease/*` 反代到本机的网易云 API，做到单 origin、无跨域。
//
// 用法：npm run build && npm start，然后手机浏览器打开 http://127.0.0.1:3000
// 环境变量见 .env.example（.env / .env.local 会自动读入）。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const API_DIR = path.join(ROOT, 'api');
const NETEASE_APP = path.join(ROOT, 'node_modules', '@neteasecloudmusicapienhanced', 'api', 'app.js');

/** 依次读 .env / .env.local 到 process.env；Node 自带的 loadEnvFile 缺失时退回极简解析。 */
const loadEnvFiles = () => {
    for (const file of ['.env', '.env.local']) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) continue;
        if (typeof process.loadEnvFile === 'function') {
            try { process.loadEnvFile(full); continue; } catch { /* 交给下面的回退 */ }
        }
        try {
            for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
                const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
                if (!m) continue;
                let value = m[2].trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                if (!(m[1] in process.env)) process.env[m[1]] = value;
            }
        } catch { /* 读不到就当没配 */ }
    }
};
loadEnvFiles();

const PORT = Number(process.env.PORT || 3000);
const NETEASE_PORT = Number(process.env.NETEASE_PORT || 3300);
const AUTOSTART_NETEASE = process.env.NETEASE_AUTOSTART !== 'false';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
});

// ---------- 网易云 API：子进程 + 反代 ----------

let neteaseChild = null;

const startNetease = () => {
    if (!AUTOSTART_NETEASE) {
        console.log(`[netease] autostart disabled; expecting an API on 127.0.0.1:${NETEASE_PORT}`);
        return;
    }
    if (!fs.existsSync(NETEASE_APP)) {
        console.warn('[netease] @neteasecloudmusicapienhanced/api not installed; /netease will 502 until you run it yourself');
        return;
    }
    neteaseChild = spawn(process.execPath, [NETEASE_APP], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(NETEASE_PORT), HOST: '127.0.0.1' },
        stdio: 'inherit',
    });
    neteaseChild.on('exit', (code, signal) => console.log(`[netease] exited (code=${code} signal=${signal})`));
};

const proxyNetease = (req, res) => {
    const targetPath = (req.url || '/').replace(/^\/netease/, '') || '/';
    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: NETEASE_PORT,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${NETEASE_PORT}` },
    }, (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
    });
    proxyReq.on('error', (error) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'netease API unreachable', detail: String(error) }));
    });
    req.pipe(proxyReq);
};

// ---------- api/ 处理器：Edge 与 Node 两种约定 ----------

const API_ROUTES = {
    '/api/healthz': null,
    '/api/generate-theme': 'generate-theme.js',
    '/api/generate-theme_openai': 'generate-theme_openai.js',
    '/api/segment-lyrics': 'segment-lyrics.js',
    '/api/lyric-proxy': 'lyric-proxy.js',
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'host']);
const handlerCache = new Map();

const loadHandler = async (file) => {
    if (!handlerCache.has(file)) {
        handlerCache.set(file, (await import(pathToFileURL(path.join(API_DIR, file)).href)).default);
    }
    return handlerCache.get(file);
};

const toFetchRequest = (req, body) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
    }
    const method = req.method || 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
    return new Request(new URL(req.url, `http://${req.headers.host || 'localhost'}`), {
        method,
        headers,
        body: hasBody ? body : undefined,
    });
};

const sendFetchResponse = async (res, response) => {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
};

/** Node 形态处理器用的最小 Vercel 兼容层：req.query / req.body + res.status()/json()/send()。 */
const attachNodeCompat = (req, body) => {
    req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries());
    const contentType = String(req.headers['content-type'] || '');
    const text = body.toString('utf8');
    if (text) {
        if (contentType.includes('application/json')) {
            try { req.body = JSON.parse(text); } catch { req.body = text; }
        } else {
            req.body = text;
        }
    }
};

const handleApi = async (req, res, file) => {
    if (file === null) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'folia-termux' }));
        return;
    }
    const body = await readBody(req);
    const handler = await loadHandler(file);
    if (handler.length >= 2) {
        attachNodeCompat(req, body);
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload)); return res; };
        res.send = (payload) => { res.end(Buffer.isBuffer(payload) ? payload : String(payload)); return res; };
        await handler(req, res);
        return;
    }
    await sendFetchResponse(res, await handler(toFetchRequest(req, body)));
};

// ---------- 静态文件（dist/）与 SPA 回退 ----------

const serveStatic = (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // 有扩展名却找不到 → 真 404；否则交给 SPA（刷新子路由不 404）。
        if (path.extname(pathname)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        filePath = path.join(DIST, 'index.html');
    }
    fs.createReadStream(filePath)
        .on('error', () => { res.writeHead(404).end(); })
        .pipe(res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }));
};

// ---------- 启动 ----------

if (!fs.existsSync(DIST)) {
    console.error('[folia-termux] dist/ not found. Run `npm run build` first.');
    process.exit(1);
}

const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const apiFile = Object.prototype.hasOwnProperty.call(API_ROUTES, pathname) ? API_ROUTES[pathname] : undefined;

    const run = apiFile !== undefined
        ? () => handleApi(req, res, apiFile)
        : pathname.startsWith('/netease/') || pathname === '/netease'
            ? () => proxyNetease(req, res)
            : () => serveStatic(req, res);

    Promise.resolve().then(run).catch((error) => {
        console.error('[folia-termux] request failed:', error);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
});

startNetease();
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[folia-termux] web + api on http://127.0.0.1:${PORT}`);
    console.log(`[folia-termux] netease proxied at /netease -> 127.0.0.1:${NETEASE_PORT}`);
});

const shutdown = () => {
    try { neteaseChild?.kill(); } catch { /* 忽略 */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
