# web-guest-token-cookie · DSH 类脚手架

**用途：** 上游是「loopback Web UI + `?token=` → cookie 会话」时，复制本目录到外置 App 的 `.agnx/`，**不要**再改 Agnx 核（guest-proxy / `/ws`）。

**权威：** `skills/agnx-app/SKILL.md`（「DSH 类接入清单」）· `docs/sub-app/子应用宿主层架构_sub-app-host-layer-architecture.md` §6

## 文件

| 模板                    | 落到外置 App                                                             |
| ----------------------- | ------------------------------------------------------------------------ |
| `manifest.json`         | `.agnx/manifest.json`（改 `id` / `name` / icon / ensure 路径）           |
| `agnx-src-panel.tsx`    | `.agnx/src/panel.tsx`（替换 `{{…}}`）                                    |
| `agnx-src-index.ts`     | `.agnx/src/index.ts`                                                     |
| `agnx-package.json`     | `.agnx/package.json`                                                     |
| `tools-ensure-stub.mjs` | `.agnx/tools/ensure-<app>.mjs`（换成真 spawn；**stdout JSON 合同不变**） |
| `README.md`             | 可并入外置仓 `EMBED.md` / `.agnx/README.md`                              |

## 最小步骤

1. **推荐：** `npm run sub-apps:scaffold:web-guest -- --app-id=<id> --name="<名>"`（自动替换占位符）
2. 或手工复制并替换全部 `{{PLACEHOLDER}}`
3. ensure 脚本 stdout 必须能被宿主解析为：`{ "ok": true, "origin": "http://127.0.0.1:<port>/?token=…" }`（loopback + **必有 token**）；合同样例见同目录 `ensure-contract.fixture.json`
4. `cd .agnx && npm i && npm run build`
5. Agnx：重新扫描子应用 → 网页 9222 / 桌面分别打开 Tab
6. 改完 panel 跑：`npm run sub-apps:assert-edge-to-edge`（在 Agnx 仓）
7. **若改了 Agnx `packages/server`：** `npm run build:daemon` 再重启 6767（supervisor 吃 `dist/`）

挂载过渡由宿主注入品牌 Logo 扫光，Panel **不要**再画纯文字「正在启动…」。

## 验收（预期）

| 层          | 预期                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| UI          | 遮罩保留到页面 load；失败显示 `GUEST_*`；无长时间空白卡死                                                           |
| 详情        | 命令面板 → 本 App → 详情 →「Guest Surface」可复制（含 correlationId / phaseTrail）                                  |
| Cookie      | `agnx-guest-sid` + 上游 auth cookie，`Path=/`                                                                       |
| daemon 日志 | `guest-proxy: http forward` → `http upstream response`；`guest-proxy: ws upgrade forward` → `ws upstream connected` |
| WS          | `ws://localhost:6767/api/…`（或绝对 `/api/remote.mux`）握手 **101**，不是 400                                       |

## 禁止

- 手写 `<iframe src=ensureOrigin>` 绕过 `host.guest.mount`
- App 私有反向代理 / 按接口白名单
- 要求上游关掉 `SameSite=Strict`
- 在 `packages/server` 写该 App 的 spawn/health
