import path from 'path';
import { fileURLToPath } from 'url';
import { type ConfigEnv, type UserConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';
import { devApiPlugin } from './dev/api/devApiPlugin.mjs';
import { normalizeBuildCommit, resolveBuildKind, resolveBuildRepo } from './dev/build/buildIdentity.mjs';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LYRIC_PROXY_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
  'Access-Control-Allow-Headers': [
    'X-CSRF-Token',
    'X-Requested-With',
    'Accept',
    'Accept-Version',
    'Content-Length',
    'Content-MD5',
    'Content-Type',
    'Date',
    'X-Api-Version',
    'KG-Rec',
    'KG-RC',
    'KG-CLIENTTIMEMS',
    'mid',
    'x-router',
  ].join(', '),
};

const LYRIC_PROXY_IGNORED_FORWARD_HEADERS = ['host', 'connection', 'content-length', 'origin', 'referer'];

function isAllowedLyricProxyHost(hostname: string): boolean {
  return hostname === 'qq.com' || hostname.endsWith('.qq.com') ||
    hostname === 'y.gtimg.cn' ||
    hostname === 'kugou.com' || hostname.endsWith('.kugou.com') ||
    hostname === 'kgimg.com' || hostname.endsWith('.kgimg.com');
}

function setLyricProxyCorsHeaders(res: import('http').ServerResponse): void {
  Object.entries(LYRIC_PROXY_CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function sendLyricProxyJson(res: import('http').ServerResponse, statusCode: number, body: unknown): void {
  setLyricProxyCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readDevRequestBody(req: import('http').IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function devLyricProxyPlugin() {
  return {
    name: 'folia-dev-lyric-proxy',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        if (requestUrl.pathname !== '/api/lyric-proxy') {
          next();
          return;
        }

        if (req.method === 'OPTIONS') {
          setLyricProxyCorsHeaders(res);
          res.statusCode = 200;
          res.end();
          return;
        }

        const targetUrlStr = requestUrl.searchParams.get('url');
        if (!targetUrlStr) {
          sendLyricProxyJson(res, 400, { error: 'Missing url parameter' });
          return;
        }

        try {
          const targetUrl = new URL(targetUrlStr);
          if (!isAllowedLyricProxyHost(targetUrl.hostname)) {
            sendLyricProxyJson(res, 403, { error: 'Forbidden: Domain not allowed' });
            return;
          }

          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (!LYRIC_PROXY_IGNORED_FORWARD_HEADERS.includes(key.toLowerCase()) && value) {
              headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
          }

          const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '');
          const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers,
            body: hasBody ? await readDevRequestBody(req) : undefined,
          });

          setLyricProxyCorsHeaders(res);

          res.statusCode = response.status;
          res.statusMessage = response.statusText;
          const contentType = response.headers.get('content-type');
          if (contentType) {
            res.setHeader('Content-Type', contentType);
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          res.end(buffer);
        } catch (error) {
          console.error('Vite lyric proxy request failed:', error);
          sendLyricProxyJson(res, 500, { error: 'Proxy request failed', details: String(error) });
        }
      });
    },
  };
}

// 构建结束后的兜底退出：某些环境（实测 Termux/Android）在打印 "built in" 之后仍有一个残留句柄
// （网络 socket、watcher 或原生线程）拖着 Node 不结束，只能 Ctrl+C。产物此时已经写完，这里在
// closeBundle（enforce: post，排在 PWA 写 sw.js 之后）再给一小段宽限，然后强制退出，保证命令一定返回。
// 用 FOLIA_BUILD_NO_FORCE_EXIT=true 可以关掉这个行为。
const BUILD_EXIT_GRACE_MS = 1500;

function buildExitPlugin() {
  return {
    name: 'folia-termux-build-exit',
    apply: 'build' as const,
    enforce: 'post' as const,
    closeBundle() {
      if (process.env.FOLIA_BUILD_NO_FORCE_EXIT === 'true') return;
      setTimeout(() => process.exit(process.exitCode ?? 0), BUILD_EXIT_GRACE_MS);
    },
  };
}

export default async function viteConfig(_config: ConfigEnv): Promise<UserConfig> {
  let commitHash = '';
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    commitHash = process.env.VERCEL_GIT_COMMIT_SHA.substring(0, 7);
  } else {
    try {
      commitHash = execSync('git rev-parse --short HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get commit hash:', e);
      commitHash = 'unknown, probably dev version';
    }
  }

  let gitBranch = '';
  if (process.env.VERCEL_GIT_COMMIT_REF) {
    gitBranch = process.env.VERCEL_GIT_COMMIT_REF;
  } else {
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get git branch:', e);
      gitBranch = 'unknown';
    }
  }

  let commitSuffix = '';
  const canResolveCommitName = /^[0-9a-f]{7,40}$/i.test(commitHash) && !/^0+$/.test(commitHash);
  // 默认不在构建期请求外部服务解析 commit 名：这次 fetch 在 Termux / 国内网络下会留下一个连不上的
  // socket，让 `vite build` 在打印 "built in" 之后一直不退出（只能 Ctrl+C）。它只影响显示用的
  // __COMMIT_HASH__ 后缀，需要时用 FOLIA_RESOLVE_COMMIT_NAME=true 打开；自建地址可用 FOLIA_COMMIT_NAME_URL。
  if (process.env.FOLIA_RESOLVE_COMMIT_NAME === 'true' && canResolveCommitName) {
    const commitNameUrl = process.env.FOLIA_COMMIT_NAME_URL?.trim() || 'https://namoe.izuna.top/api/namoe';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${commitNameUrl}?hash=${commitHash}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as { name?: string };
        if (data?.name) {
          commitSuffix = `/${data.name}`;
        }
      }
    } catch (e) {
      // Ignore errors during fetch to prevent build failure
    }
  }
  if (process.env.REQUIRE_COMMIT_NAME === 'true' && canResolveCommitName && !commitSuffix) {
    throw new Error(`Could not resolve the commit name for ${commitHash}`);
  }

  // 请求 AMLL 官方 API 时 UA 里的构建身份，见 dev/build/buildIdentity.mjs
  const buildRepo = resolveBuildRepo(process.env, () => execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const buildCommit = normalizeBuildCommit(commitHash);
  // 官方 / 自部署 / 非官方：设置里的版本号、扫码诊断报告和反馈入口都会读它
  const buildKind = resolveBuildKind(process.env);

  const appVersionLabel = process.env.APP_VERSION_LABEL?.trim() || 'Realeco';
  const appReleaseChannel = process.env.APP_RELEASE_CHANNEL?.trim().toLowerCase() || 'realeco';
  const dockerStackVersion = process.env.DOCKER_STACK_VERSION?.trim() || '';

  return {
    base: '/',
    worker: {
      format: 'es'
    },
    optimizeDeps: {
      // Only metadataParser.worker.ts imports music-metadata, and the startup dep scan does not
      // follow worker entries. Left out, the first local import discovers it at runtime, Vite
      // re-optimizes, and every open page is force-reloaded ("optimized dependencies changed").
      include: ['music-metadata'],
    },
    build: {
      rollupOptions: {
        input: {
          main: 'index.html',
          modExport: 'mod-export.html',
        },
        output: {
          // three.js is a large dependency used only by the diorama 3D visualizer. Split it into its
          // own chunk so it doesn't bloat the main bundle past the PWA precache size limit (each file
          // must stay under workbox.maximumFileSizeToCacheInBytes to be cached for offline use).
          manualChunks(id) {
            return id.includes('/node_modules/three/') ? 'three' : undefined;
          },
          // folium.ui.icon loads each lucide icon as its own chunk (~2000 of them). They live in one
          // directory so the PWA precache can leave them out: only mods ask for them, and mods run in
          // the desktop app, which does not go through the service worker.
          chunkFileNames(chunk) {
            return chunk.moduleIds.some(id => id.includes('/node_modules/lucide-react/dist/esm/icons/'))
              && chunk.moduleIds.length === 1
              ? 'assets/folium-icons/[name]-[hash].js'
              : 'assets/[name]-[hash].js';
          },
        },
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // 开发模式与 server/index.mjs 的线上一形态保持一致：前端只用相对 /netease，避免跨端口 CORS 与
      // 手机端 host 差异。netease API 需另起在 127.0.0.1:3300（见 README）。
      proxy: {
        '/netease': {
          target: 'http://127.0.0.1:3300',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/netease/, ''),
        },
      },
      watch: {
        // 构建产物与模型权重不是源码。
        ignored: ['**/release/**', '**/models/**'],
      },
    },
    plugins: [
      devApiPlugin(),
      devLyricProxyPlugin(),
      commandPinyinPlugin(),
      react(),
      // PWA / service worker：手机本地部署用不到离线缓存，且 workbox 生成 SW 这一步在 Termux 上
      // 最可能卡住或报错（卡在这里时 dist/ 会不完整，`npm run web` 起不来）。用
      // FOLIA_DISABLE_PWA=true 可跳过，直接得到可用的 dist/。
      ...(process.env.FOLIA_DISABLE_PWA === 'true' ? [] : [VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg'],
        devOptions: {
          enabled: true
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 5000000,
          // Docker serves this file dynamically; it must never be pinned in the PWA precache.
          globIgnores: ['**/runtime-config.js', '**/assets/folium-icons/**'],
          // API navigations must reach the deployment platform instead of the SPA shell.
          navigateFallbackDenylist: [/^\/api(?:\/|$)/]
        },
        manifest: {
          name: 'Folia Music',
          short_name: 'Folia',
          description: 'A beautiful AI-themed music player',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          icons: [
            {
              src: 'icon.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            }
          ]
        }
      })]),
      buildExitPlugin()
    ],
    define: {
      '__COMMIT_HASH__': JSON.stringify(commitHash + commitSuffix),
      '__GIT_BRANCH__': JSON.stringify(gitBranch),
      '__BUILD_REPO__': JSON.stringify(buildRepo),
      '__BUILD_COMMIT__': JSON.stringify(buildCommit),
      '__BUILD_KIND__': JSON.stringify(buildKind.kind),
      '__BUILD_HOST__': JSON.stringify(buildKind.host ?? ''),
      '__APP_VERSION__': JSON.stringify(JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')).version),
      '__APP_VERSION_LABEL__': JSON.stringify(appVersionLabel),
      '__APP_RELEASE_CHANNEL__': JSON.stringify(appReleaseChannel),
      '__DOCKER_STACK_VERSION__': JSON.stringify(dockerStackVersion)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    }
  };
}
