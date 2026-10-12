import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadEnv } from 'vite';

// dev/api/devApiPlugin.mjs
// 本地 `npm run dev` 用的开发期 API 桥：把仓库里 Vercel/Cloudflare 的 serverless 入口
// （api/*.js）挂到 Vite 开发服务器上，这样网页版不需要 `vercel dev` 也能用 AI 主题生成和
// 歌词分词。只对 serve 生效，构建产物完全不受影响（apply: 'serve'）。
//
// 这些入口分两种形态：
//   - edge：`export default (request: Request) => Response`（generate-theme_openai / segment-lyrics / qq）
//   - node：`export default (req, res) => void`（generate-theme / lyric-proxy，后者已由 vite 内的歌词代理处理）
// 用函数入参个数区分，edge 造 Request 再回写 Response，node 补齐 req.body 与 res.status/res.json。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '../../api');

// 路由 -> api/ 下的入口文件。lyric-proxy 由 vite.config.ts 里的 devLyricProxyPlugin 处理，这里不重复挂。
const ROUTES = {
  '/api/generate-theme': 'generate-theme.js',
  '/api/generate-theme_openai': 'generate-theme_openai.js',
  '/api/segment-lyrics': 'segment-lyrics.js',
};

const handlerCache = new Map();

const loadHandler = async (file) => {
  if (!handlerCache.has(file)) {
    const mod = await import(pathToFileURL(path.join(API_DIR, file)).href);
    handlerCache.set(file, mod.default);
  }
  return handlerCache.get(file);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const toRequest = (req, body) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else if (value !== undefined) headers.set(key, String(value));
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method,
    headers,
    body: hasBody && body.length > 0 ? body : undefined,
  });
};

const writeResponse = async (res, response) => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    try {
      res.setHeader(key, value);
    } catch {
      // 某些受保护的响应头（如 content-length）由 Node 自己管理，忽略即可。
    }
  });
  res.end(Buffer.from(await response.arrayBuffer()));
};

/** node 形态入口（req,res）在 connect 的 res 上没有 status/json，这里补上最小实现。 */
const attachNodeHelpers = (req, body) => {
  const contentType = String(req.headers['content-type'] ?? '');
  const text = body.toString('utf8');
  if (contentType.includes('application/json') && text) {
    try {
      req.body = JSON.parse(text);
    } catch {
      req.body = undefined;
    }
  }
};

export function devApiPlugin() {
  return {
    name: 'folia-dev-api',
    apply: 'serve',
    configResolved(config) {
      // serverless 入口读的是 process.env（OPENAI_*、GEMINI_API_KEY 等），而 Vite 默认只把变量
      // 交给 import.meta.env。这里把 .env / .env.local 全量同步进 process.env，行为对齐 vercel dev。
      Object.assign(process.env, loadEnv(config.mode, config.envDir, ''));
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const file = ROUTES[new URL(req.url ?? '/', 'http://localhost').pathname];
        if (!file) {
          next();
          return;
        }

        try {
          const body = await readBody(req);
          const handler = await loadHandler(file);

          if (handler.length >= 2) {
            attachNodeHelpers(req, body);
            res.status = (code) => {
              res.statusCode = code;
              return res;
            };
            res.json = (payload) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(payload));
              return res;
            };
            await handler(req, res);
            return;
          }

          await writeResponse(res, await handler(toRequest(req, body)));
        } catch (error) {
          console.error('[dev-api]', req.url, error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    },
  };
}
