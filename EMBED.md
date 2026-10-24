# DS Bot 融入 Agnx 分析（子应用 `ds-bot`）

> 上游仓库：https://github.com/Fei2411/DeepSeek-Bot（DS Bot）
> 上游本机副本：`~/Downloads/DeepSeek-Bot-main`
> 落地目录：`$AGNX_HOME/apps/ds-bot/`
> 状态：**已落地并通过桌面端验收**（`launchMode=packaged`、`installState=installed`）
> 验收截图：`$AGNX_HOME/apps/ds-bot/acceptance-desktop.png`

---

## ① 能力与边界

**一句话**：DS Bot 是一个跑在 DeepSeek Harness（DSH）里的**常驻 Bot 团队**——多个 Main Bot 各自持有会话记忆、彼此可以互发消息、并有群聊房间，用户在一个统一工作台里指挥它们长期协作。

**它提供什么**

| 能力 | 说明 |
| --- | --- |
| Bot 团队 | `state.json` 持久化：Main Bot 列表、Bot 元数据、会话（Session）归属、房间（room）、agent、能力项、偏好 |
| Bot 间通信 | Bot 可以给另一个 Bot 发消息；有 `exchange` 交换记录与轮次计数 |
| 群聊 | 多 Bot 同房协作，房间有模式（`ROOM_MODES`） |
| 团队记忆 | `src/host/memory.js`：按 Session 冻结记忆，单进程持有团队 |
| Web 搜索 | `src/host/*` + `web-search.js`，按当前会话路由的 key 走，否则用无 key 的兜底结果页 |
| 客户端形态 | 浏览器半壳通过 `package.json` 的 `dsh.client` 暴露 `./client`，以 DSH 客户端插件形式接管侧栏 |

**边界（必须明确，否则会误判集成方式）**

1. **DS Bot 不是一个可独立启动的 HTTP 服务。** 它是 **DSH 插件**（宿主半 `index.js` + 浏览器半 `./client`）。"启动 DS Bot 服务"实际含义是"**管理一个跑着 `ds-bot` 插件的 `dsh web` 实例**"。这是本方案所有设计的前提。
2. DS Bot 的浏览器半是**接管 DSH Web 的侧栏槽位**（`sidebar.workspaces`／`sidebar.brand.mark`／`sidebar.brand.name`／`sidebar.footer.action`），不是独立页面。所以**只能整站嵌入 `dsh web` 的页面**，无法只嵌"DS Bot 的那一块 UI"。
3. 它假设自己是**唯一写入者**：`src/host/home-lock.js` 实现了"一个 plugin home 只允许一个写入者"。
4. 模型凭证不在包内，来自 DSH 的 credentials 服务。

---

## ② 重叠 / 缺口

### 与子应用 `deepseek-harness` 的关系（重点）

| 维度 | 现有 `deepseek-harness` 子应用 | 新 `ds-bot` 子应用 | 结论 |
| --- | --- | --- | --- |
| 本质 | DSH 本体（Web 工作台） | DSH + `ds-bot` 插件 | **同一宿主，不同 profile** |
| DSH_HOME | 自己的 | **自己的，完全独立** | 隔离 |
| profile | `web`（base + web-app） | `web`（base + web-app + `ds-bot`） | 各自 home 下同名不同文件 |
| 端口 | 自己的 | **13080** | 不冲突 |
| 谁启动 | 自己的 ensure 工具 | 自己的 `.agnx/tools/ensure-ds-bot.mjs` | **各管各的** |

**明确结论：不共享 DSH 实例，不复用用户的 `~/.dsh`，不搭 `deepseek-harness` 的便车。ds-bot 独占一个由 Agnx 托管的 `dsh web`。**

### 为什么不能共用（实测 + 读码双重依据）

**依据一：`home-lock.js` 让第二个宿主变只读。** 我实测在同一 `DSH_HOME` 上起第二个 `dsh web`（13081），日志直接打印：

```
[ds-bot] ds-bot: The Bot team in .../dsh-home/bot is open in another dsh (Web or Desktop,
pid 63236 on MacBook-Pro). This window shows the team but cannot change it;
close the other one and reload.
```

第二实例能起来、能看，但**改不了团队**。共用 home 会得到"两个窗口抢一个只读团队"的坏体验。

**依据二：会把用户主 profile 弄脏。** 用户的 DSH 跑在 3080，`DSH_HOME=$AGNX_HOME/apps/data/deepseek-harness/dsh-home`，是手工维护的工作流。往里装 `ds-bot` 插件（`dsh.profile.bundles`）和塞 Bot 团队状态，属于对用户主环境的侵入式修改。

**依据三：生命周期要独立。** 子应用要能单独启停、单独清数据、单独升级。共用实例时"关掉 DS Bot"就等于"关掉用户的 DSH"。

**接受的代价**：凭证不继承。隔离的 `DSH_HOME` 里没有 `.credentials.yaml` 的 key，这是**显式的一次性配置成本**，已在 ⑥ 给出解法（且已实现为自动透传）。

### 与 Agnx 既有能力的重叠

- 与 `deepseek-harness` 子应用：**宿主相同、profile 不同**，无功能重叠。
- 与 Agnx 自身的会话/Agent 体系：**语义相近但数据不通**。DS Bot 的 Bot 团队活在它自己的 `state.json` 里，不进入 Agnx 的 agent 列表。这是有意的——它是"另一个产品"，不是 Agnx 的一个视图。

### 缺口

| 缺口 | 处置 |
| --- | --- |
| DS Bot 无独立 UI 入口 | 嵌整站 `dsh web` 页面（见 A） |
| 无凭证 | ensure 工具自动透传宿主 `*_API_KEY`/`*_TOKEN`（见 ⑥） |
| 无独立健康检查 | 用 `dsh web` 的监听端口 + stdout token 行（见 D） |

---

## ③ 推荐路径及理由

**路径：外挂子应用 `ds-bot` + `guest` 整站嵌入 + 独立 sidecar `dsh web`。**

理由：

1. **符合 AGENTS.md 分流原则**：DS Bot 是行业场景逻辑而非跨 App 协议，它的 UI 是现成的第三方 DSH 客户端插件，`port` 进 Agnx 核心会把 DSH 插件系统耦合进 Agnx。落子应用是正确位置。
2. **零改造上游**：`ds-bot` 用 `link:` 方式装进独立 profile，上游仓库（`Downloads/DeepSeek-Bot-main`）一行不改，升级只需重装 plugin。
3. **嵌入形态已验证可行**：`guest-webview` 策略在 Electron 上渲染 `<webview>`，DS Bot 的整站 UI 可以真正贴边、可交互（见验收证据）。
4. **不碰用户主环境**：独立 `DSH_HOME` + 独立端口 13080，3080 的手工工作流完全不受影响。

**为什么不是 core**：把 DSH 插件加载器、Bot 团队状态机、`state.lock` 语义搬进 Agnx 核心，收益低且风险高（AGENTS.md 禁止平行核）；而子应用已经能拿到完整的真实 UI。

---

## ④ 要迁的核心模块 / 调用链

本次是**嵌入集成**，不搬迁上游代码。以下为理解与维护所需的核心调用链（均在上游 `ds-bot/` 内）：

**A. 插件装载链**
```
独立 profile package.json
  dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ds-bot"]
      ↓ dsh web 启动
cordis.patch.yml  → insert: [id: bot, name: ds-bot]  /  [id: web-search-auto, name: ds-bot/web-search]
      ↓
index.js → src/host/*（install(rt) 逐模块注册）
```

**B. 状态与锁链（多实例冲突的根源）**
```
src/host/store.js  install(rt)
  homeLock(join(home, 'state.lock'))        ← src/host/home-lock.js
  claim() → 拿不到就 holder=… → readOnly() 返回中文/英文只读提示
  state.json 整份读 + 整份写（writeFileSession / rename）
```

**C. 浏览器半装载链**
```
package.json → dsh.client（manifest）+ ./client 导出
  ↓
ctx.slots.inject / register
  遮蔽：sidebar.workspaces / sidebar.brand.mark / sidebar.brand.name / sidebar.footer.action
  ↓
模式切换入口落在「底部账号菜单」← 这是 iframeShortcutCapture 必须为 true 的原因
```

**D. 凭证链（决定 ds-bot 能否真正对话）**
```
ds-bot 发消息 → llm-deepseek 路由 "deepseek-official"
  → ctx.credentials.resolve(DEEPSEEK_API_KEY)
     · 有 credentials 服务时 **只**走它（不看 process.env）
       —— 见 @deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js
  → dsh-credentials-local 的 resolve() 分层：
       1. inherited = process 环境（source: "env"）   ← 优先级最高
       2. 文件 .credentials.yaml（source: "file"）
       3. .env 兜底（project-env > user-env）
  → 都没有 → LlmError(..., "MISSING_CREDENTIAL")
```

> 这条链是本次排查的关键：`DSH_HOME` 隔离后文件层为空，但**环境层仍在**，所以 ensure 工具把宿主的 key 透传进 `dsh web` 子进程即可生效，**无需把密钥写盘**。

---

## ⑤ 最小落地切片（已完成）

```
$AGNX_HOME/apps/ds-bot/
├── EMBED.md                      ← 本文
├── acceptance-desktop.png        ← 桌面端验收截图
└── .agnx/
    ├── manifest.json             ← id/name/icon/sidecar/guest/contributes
    ├── config.json               ← launchMode=packaged, installState=installed
    ├── icon.svg                  ← 取自上游 docs/images/logo.svg
    ├── package.json              ← @agnx-sub/ds-bot，依赖全走 peer
    ├── scripts/build.mjs         ← esbuild → dist/index.js
    ├── src/index.ts              ← re-export
    ├── src/panel.tsx             ← 面板 + activate + registerMiniApp/Command
    ├── tools/ensure-ds-bot.mjs   ← sidecar：拉起/复用/停掉 13080 的 dsh web
    └── dist/index.js             ← 构建产物
```

**关键配置**

| 项 | 值 |
| --- | --- |
| `guest.kind / auth` | `web` / `url-token-then-cookie` |
| `guest.capabilities` | `["cookies", "websocket"]` |
| `guest.preferStrategy` | `auto`（Electron→`guest-webview`；Web→`proxied-iframe`） |
| `isolation.mode` | `iframe` |
| `iframeShortcutCapture` | `true` |
| `sidecar.defaultPort` | `13080`（**永不用 3080**） |
| 面板根样式 | `backgroundColor: "transparent"` |

**运行期数据**（全部在 Agnx 数据根下，不污染用户目录）

```
$AGNX_HOME/apps/data/ds-bot/
├── dsh-home/          ← 独立 DSH_HOME
│   └── profiles/web/  ← ds-bot plugin 以 link: 装在此
├── work/              ← dsh web 的 cwd
├── dsh-web.log        ← 实例日志
└── ds-bot.json        ← 状态（pid/port/reused）
```

**`~/.dsh` 的处置：不复用、不读取、不写入。** DSH 通过 `DSH_HOME` 环境变量重定向，ensure 工具显式注入 `DSH_HOME=<AGNX_APP_DATA_ROOT>/dsh-home`，因此 `~/.dsh` 完全不参与。

---

## ⑥ 上机与用户路径

### 启动流程

1. Agnx 打开 `DS Bot` Tab → 面板 `host.guest.mount(...)` 
2. → `ensure-ds-bot.mjs --port 13080`
3. 工具判断：端口被**自己的**上次实例占用 → 直接复用；空闲 → 拉起
4. 拉起命令：`dsh web --host 127.0.0.1 --port 13080 --no-open`，env 含 `DSH_HOME`、`DSH_TELEMETRY_DISABLED=1`，以及**从宿主环境透传的凭证**
5. 等到端口监听 → 等 stdout 出现 `dsh web: <带 token 的 URL>` → 写状态 → 输出**单行 JSON**
6. 宿主用该带 token 的 URL 挂载页面；`url-token-then-cookie` 落地 cookie

### 凭证：已自动解决，但有前提

ensure 工具会把启动环境里形如 `DEEPSEEK_API_KEY`／`*_API_KEY`／`*_TOKEN` 的变量透传给 `dsh web` 子进程。**前提是 Agnx 宿主自身的启动环境里带着这个 key。**

三种补 key 的方式（任选其一）：

| 方式 | 做法 | 特点 |
| --- | --- | --- |
| **透传（推荐，已实现）** | 在导出了 `DEEPSEEK_API_KEY` 的 shell 里启动 Agnx/Dev 桌面 | 不落盘，与用户已有习惯一致 |
| Web 端写入 | 打开 DS Bot → 底部**账户**菜单 → 模型设置 → 写入 | 落盘到隔离 `.credentials.yaml`，仅该子应用可见 |
| 不配置 | —— | 界面可用，但每次发消息报 `MISSING_CREDENTIAL` |

> 若三者都没做，ensure 工具会在输出的 JSON 的 `warnings` 里显式提示，不会静默失败。

### 使用路径（嵌页后必须知道的操作顺序）

```
子应用 → 打开「DS Bot」Tab
   ↓
首屏 = Chief 的首轮对话（引导页）
   ↓
点 DeepSeek-V41-Flash / DeepSeek-V4-Pro 选模型（或「管理模型」进模型管理）
   ↓
进入 Bot 主界面：
   · 左侧竖排 = Bot 头像列表，「+」新建 Bot
   · 中间 = 与当前 Bot 的会话
   · 底部输入框「给 Chief 发消息」
   ↓
换模型：点顶部 Chief → 详情页
模式切换：底部「账户」菜单   ← 需 iframeShortcutCapture 才能拿回快捷键
```

### ⚠️ 已知问题：模型 ID 与 API 不匹配（HTTP_404）

验收时实测到：界面展示的模型名（`DeepSeek-V41-Flash`）**不是** API 接受的 ID。API 实际 ID 为：

```
deepseek-flash     → 显示名 DeepSeek-V4.1-Flash（1M 上下文，支持图片）
deepseek-v4-pro    → 显示名 DeepSeek-V4-Pro
```

因此用默认模型发消息会得到 `本轮运行失败 DeepSeek Messages request failed (404) HTTP_404`。**这是上游/凭据侧的配置问题，不是嵌入缺陷**（凭证已通、请求已发出、只是模型名不被接受）。处置建议：在「管理模型」里把模型 ID 改为 `deepseek-flash`。

另：测试所用 key 对该 endpoint 返回 `402`（额度不足），也会阻断真实对话。这两点都需要在接入前解决。

---

## ⑦ 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **多实例只读** | 同一 `DSH_HOME` 起第二个 dsh，后起的只读 | 端口 13080 单一实例由 sidecar 独占；实测已验证 |
| **端口被外部占用** | ensure 失败 | 工具有 foreign-port 守卫，检测到非自己实例时拒绝并报警，不盲目杀进程 |
| **模型 ID / 额度** | 对话 404 或 402 | 见 ⑥，需用户在模型设置里校正 |
| **凭证透传依赖宿主环境** | 宿主没带 key 则 `MISSING_CREDENTIAL` | ensure 的 `warnings` 显式提示 + ⑥ 的三条补法 |
| **上游以 `link:` 安装** | 上游目录被删/移动即失效 | 属预期；升级即重装 plugin，不复制代码保持可追溯 |
| **DSH 版本漂移** | `dsh` 升级可能改变 profile/插件契约 | sidecar 动态解析 dsh CLI（`DSH_BOT_DSH_CLI` 可覆盖），失败时给出可读错误 |
| **桌面端 `webview` vs Web 端 `iframe`** | 两端 DOM 不同，选择器易踩空 | 面板只认 `[data-agnx-guest-surface-host]` 作用域；断言同时匹配 `webview, iframe` |
| **共享桌面上第三方抢占焦点** | 截图/断言被打断 | 每次取证前重新激活 DS Bot Tab；用 `getBoundingClientRect()` 定位，不靠截图坐标 |
| **面板状态在切 Tab 后卸载** | `webview` target 消失 | 属正常挂载/卸载行为，重进 Tab 会重新 ensure（复用同一实例） |

---

## 嵌页宿主能力缺口

| 处置 | 主路径 | 备注 |
| --- | --- | --- |
| **A** | 整站 `guest.mount` 嵌入 `dsh web`（13080） | DS Bot 无独立 UI，浏览器半只是 DSH 的侧栏插件，只能整站嵌。Electron→`<webview>`，Web→代理 iframe |
| **B** | `url-token-then-cookie` + sidecar 从 stdout 取 token | DSH 的就绪 URL 只在**所有必需插件激活后**才打印 `dsh web: <url>?token=…`；这正是"插件真的装好了"的强信号 |
| **C** | `iframeShortcutCapture: true` | 模式切换与账号操作在**底部账号菜单**，不捕获快捷键会被 Agnx 抢走。已开启 |
| **D** | sidecar 端口监听 + token 行双条件就绪 | 不用 HTTP 健康端点（DSH 未提供业务级健康检查）；`ensure` 超时 180s |
| **E** | 凭证走环境透传，不落盘 | 隔离 `DSH_HOME` 使文件层为空，但 credentials 的 `resolve()` 环境层优先级最高，故透传生效 |

---

## 验收证据

| 项 | 结果 |
| --- | --- |
| `npm run sub-apps:assert-edge-to-edge` | **PASS 35 files**（含 `ds-bot/.agnx/src/panel.tsx`） |
| 面板根 `backgroundColor` | `rgba(0, 0, 0, 0)`（透明） |
| 是否"状态页 + 打开外部应用" | **否**，无状态页 |
| 挂载元素 | `WEBVIEW`，`src=http://127.0.0.1:13080/` |
| 尺寸 | 面板 `1008×731 @ (306,145)`，视口 `1314×876` → 贴边无内边距 |
| 真实 UI | `wvTitle="Chief — DeepSeek Harness"`，Bot 栏 / 会话区 / 输入框 `给 Chief 发消息` 全部可见可交互 |
| LogBox / 红屏 | `logbox: false`，`runtime-devtools gate error` 为空 |
| 交互验证 | 点击模型选择 → 触发真实请求（`2 轮 2 步`），证明面板内 UI 可操作 |
| 注册状态 | `launchMode=packaged`、`installState=installed` |
| 邻接实例未受影响 | 3080 → PID 11273 未被触碰；6767 → PID 39554 未被重启 |
