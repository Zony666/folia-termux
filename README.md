# Folia-Termux

把 [Folia](https://github.com/chthollyphile/folia-major) 的 **Web 版**搬进 Termux（Android）本地跑的专用项目。
**只保留跑网页版所必需的部分**：去掉了 Electron 桌面端、Vercel / Cloudflare serverless、Docker 与打包脚本。

配套的上游说明仍然适用，但本项目的运行方式不同，请以本文件为准。

## 它是什么

一个**单进程本地网关** `server/index.mjs`，在手机上一个 origin 里同时提供：

```
Termux
└─ node server/index.mjs
   ├─ 静态网页        dist/                http://127.0.0.1:3000
   ├─ AI 接口         /api/*               （AI 主题 / 歌词分词 / 歌词代理）
   └─ 网易云反代      /netease/*  →  127.0.0.1:3300（自动拉起网易云 API 子进程）
手机浏览器 / 添加到主屏幕 → http://127.0.0.1:3000
```

前端用相对路径 `/netease` 与 `/api`，所以是**同源、无跨域**，也不需要再单独开一个代理服务。

## 前置

- **Termux**：请用 [F-Droid](https://f-droid.org/packages/com.termux/) 或官方 GitHub Release 版本，
  **不要用 Google Play 版**（已停更，且部分静态程序跑不了）。
- **Node.js ≥ 24**：与上游 `engines` 一致。
- `git`。

```bash
pkg update && pkg upgrade
pkg install nodejs git
node -v    # 需要 v24 或更高
```

## 安装

```bash
git clone <本仓库地址> folia-termux
cd folia-termux
npm install
```

若安装时某些原生脚本报错（Termux 上常见），这些多为桌面端遗留，可先：
```bash
pkg install clang make python
npm install
```

## 配置

所有配置都在项目根目录的 **`.env.local`**（从 `.env.example` 复制）：

```bash
cp .env.example .env.local
```

| 变量 | 说明 |
| --- | --- |
| `VITE_NETEASE_API_BASE` | 前端请求网易云 API 的地址。本项目固定填 `/netease`（走同源反代）。**构建时写入**，改了要重新 `npm run build`。 |
| `VITE_KUGOU_API_BASE` / `VITE_QQ_API_BASE` | 可选音源；不部署就留空。 |
| `VITE_AI_PROVIDER` | `google`（Gemini）或 `openai`（OpenAI 兼容，如 DeepSeek）。 |
| `AI_PROVIDER` | **服务端**分词选哪个 provider。注意不是 `VITE_` 前缀。用 DeepSeek 就填 `openai`。 |
| `GEMINI_API_KEY` | 用 Gemini 时填。 |
| `OPENAI_API_KEY` / `OPENAI_API_URL` / `OPENAI_API_MODEL` / `OPENAI_API_TEMPERATURE` | 用 OpenAI 兼容接口时填。DeepSeek 示例：`https://api.deepseek.com` + `deepseek-flash`。 |
| `PORT` / `NETEASE_PORT` / `NETEASE_AUTOSTART` | 可选。网页端口默认 `3000`、网易云端口默认 `3300`、是否自动拉起网易云默认 `true`。 |

密钥只放在手机本地，不会进任何前端产物。

## 运行

```bash
npm run build     # 产出 dist/
npm start         # 起服务（同时自动拉起网易云 API）
```

然后手机浏览器打开 **http://127.0.0.1:3000**。
可选：浏览器菜单 →「添加到主屏幕」，当 PWA 用（`127.0.0.1` 属于浏览器安全上下文，可安装、可离线缓存）。

想单独跑网易云 API（例如让它保持常驻）：
```bash
npm run netease                              # PORT=3300 起网易云 API
NETEASE_AUTOSTART=false npm start            # 让网关不再重复拉起
```

## 登录（网易云，不扫码）

本项目给网易云加了 **手机号 + 短信验证码** 登录：登录弹窗顶部切到「手机号」，填号码和验证码即可，不用扫二维码
（手机本地部署时扫自己屏幕本来也不现实）。默认区号 `86`，可改。原来的「扫码」入口仍在。

手机号登录走网易云的 `/captcha/sent` 与 `/login/cellphone`，由 `server/index.mjs` 经 `/netease` 反代转发，
不需要额外配置。登录成功后登录态（cookie）存在浏览器本地，和扫码登录一致。

## 开发模式

需要热更新时用 Vite 开发服务器，AI 同样可用（`dev/api/devApiPlugin.mjs` 把 `/api` 挂上了）：

```bash
npm run netease     # 终端 1：网易云 API :3300
npm run dev         # 终端 2：Vite :3000（/netease 已配代理）
```

改 `.env.local` 后必须重启。

## 常见问题

### `npm run build` 打印 `built in` 之后不退出，只能 Ctrl+C

某些环境（实测 Termux/Android）构建完成后仍有残留句柄拖着 Node 不结束。本项目已处理：

- 构建期不再请求外部服务解析 commit 名（那个 fetch 在国内网络下会留下连不上的 socket）；需要时用
  `FOLIA_RESOLVE_COMMIT_NAME=true` 打开，自建地址用 `FOLIA_COMMIT_NAME_URL`。
- 构建结束时（`closeBundle` 之后）强制退出，所以命令一定会返回。

即便如此卡住了也可以直接 Ctrl+C——**此时 `dist/` 已经写完**，产物是完整的。想关掉兜底退出：
`FOLIA_BUILD_NO_FORCE_EXIT=true npm run build`。

## 保活（Termux 特有）

Android 会在锁屏后杀后台：

```bash
pkg install tmux
tmux new -s folia      # 在里面跑 npm start；Ctrl+b 然后 d 脱离
termux-wake-lock
```
再到 系统设置 → 应用 → Termux → 电池 → **不优化 / 无限制**。
要开机自启，安装 `Termux:Boot`，把启动脚本放进 `~/.termux/start/`（或 `~/.termux/boot/`，随版本而异）。

## 已知限制

这是「把 Web 版搬到手机」的形态，不是原生 App：

- **智能过渡 / 人声分离**：依赖桌面端的 onnxruntime，本形态退化为内置节拍估计，无人声/伴奏分离。
- **本地音乐目录**：`File System Access API` 在 Android Chrome/WebView 下受限，导入体验不如桌面。
- **后台 / 锁屏播放**：没有 Android 前台媒体服务，切后台可能暂停。
- **模组系统（Folium）**：桌面端专属，本形态不可用。
- **发热耗电**：常驻 Node 进程会明显耗电，适合「想用就开」，不适合 7×24。

## 与上游的差异

**移除**：`electron/`、`worker/`（Cloudflare）、`api-ts/`（Vercel TS 源；保留编译产物 `api/`）、
`deploy/`（Docker）、`packaging/`、`build/`、`sync-server/`、`.github/`、`vercel.json`、`wrangler.jsonc`、
测试与截图基建（`test/`、Playwright/Vitest）。

**新增**：`server/index.mjs`（本地网关）、`dev/api/devApiPlugin.mjs`（开发模式挂 `/api`）、本 README、`.env.example`。

**修改**：`package.json`（去掉 Electron/Vercel/Docker 脚本与依赖）、`vite.config.ts`（去掉 Electron 分支与 stage-client 入口，加 `/netease` 开发代理）。

前端 `src/` 未改动：它对 `window.electron` 的引用都在运行时判定，Web 环境下自动降级。

## 许可证

沿用上游 **AGPL-3.0**。在线音乐、歌词与封面版权归相应权利人所有，请遵守所在地法律并通过官方渠道支持正版。
