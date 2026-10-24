#!/usr/bin/env node
/**
 * 场景：DS Bot 子应用 sidecar 拉起器 — 在独立 DSH_HOME 里复用或拉起 `dsh web`，并回传带 token 的 origin。
 *
 * 为什么不是「另一个独立服务」：DS Bot 是 dsh 的一个插件（包根 index.js 是 host 插件、
 * client.js 是浏览器半边），没有独立进程可拉。它的宿主就是 DeepSeek Harness 的 Web GUI，
 * 所以本脚本的真实职责 = 管一个**只属于 ds-bot 的** dsh web 实例。
 *
 * 隔离三件套（与用户主 ~/.dsh、与 deepseek-harness 子应用的 3080 实例彻底分开）：
 *   1) DSH_HOME  = <本 App 的 AGNX_APP_DATA_ROOT>/dsh-home
 *   2) profile   = web（profile 目录落在上面那个 DSH_HOME 里，插件装在这个 profile）
 *   3) port      = manifest.sidecar.defaultPort（13080，避开 3080 与 6767）
 * 于是 sessions/、storages/、.credentials.yaml、logs/ 全在 App 数据根内，不污染用户主 profile。
 *
 * 契约（宿主 parseGuestEnsureToolResult + auth=url-token-then-cookie）：
 *   stdout 最后一行 JSON = { ok, port, origin, reused, pid, warnings? }
 *   origin 必须带 ?token=（dsh web 用一次性 query token 换 cookie）。
 * 用法：node ensure-ds-bot.mjs [--port 13080] [--supervised] [--force-restart] [--work-dir <dir>]
 */
import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DSH_PROFILE = "web";
const DEFAULT_PORT = 13080;
const TOKEN_QUERY = "token";
/** 冷启动（首次装依赖 / 首次编译）可能偏慢，给足宽限。 */
const HEALTH_TIMEOUT_MS = 150_000;
const TOKEN_TIMEOUT_MS = 60_000;

function trace(phase, detail) {
  // stderr 只做人类诊断；stdout 必须保持「一行 JSON」。
  process.stderr.write(`[ensure-ds-bot] ${JSON.stringify({ phase, ...detail })}\n`);
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { port: null, supervised: false, forceRestart: false, workDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--supervised") out.supervised = true;
    else if (arg === "--force-restart" || arg === "--forceRestart") out.forceRestart = true;
    else if (arg === "--port") out.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) out.port = Number(arg.slice("--port=".length));
    else if (arg === "--work-dir" || arg === "--workDir") out.workDir = argv[++i];
    else if (arg.startsWith("--work-dir=")) out.workDir = arg.slice("--work-dir=".length);
    else if (arg.startsWith("--workDir=")) out.workDir = arg.slice("--workDir=".length);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const port = Number.isFinite(args.port) && args.port > 0 ? args.port : DEFAULT_PORT;

/** 数据根：宿主注入 AGNX_APP_DATA_ROOT；独立运行兜底到 ~/.agnx-dev/apps/data/ds-bot。 */
function resolveDataRoot() {
  const injected = args.workDir || process.env.AGNX_APP_DATA_ROOT || process.env.AGNX_APP_DATA_DIR;
  if (typeof injected === "string" && injected.trim() !== "") return path.resolve(injected);
  return path.join(homedir(), ".agnx-dev", "apps", "data", "ds-bot");
}

const DATA_ROOT = resolveDataRoot();
const DSH_HOME = path.join(DATA_ROOT, "dsh-home");
const PROFILE_DIR = path.join(DSH_HOME, "profiles", DSH_PROFILE);
const STATE_PATH = path.join(DATA_ROOT, "ds-bot.json");
const WEB_CWD = path.join(DATA_ROOT, "work");
const LOG_PATH = path.join(DATA_ROOT, "dsh-web.log");

// ---------------------------------------------------------------------------
// 定位 dsh CLI
// ---------------------------------------------------------------------------

/**
 * 依次尝试：显式 env → App 内已装 → npx 缓存里的 @deepseek-ai/dsh。
 * 返回 { command, prefix } —— 直接用 lib/bin.js 当入口，绕开 .bin 软链包装层。
 */
function resolveDshLaunch() {
  const candidates = [];
  if (process.env.DSH_BOT_DSH_CLI) candidates.push(process.env.DSH_BOT_DSH_CLI);

  try {
    const require = createRequire(import.meta.url);
    candidates.push(require.resolve("@deepseek-ai/dsh/lib/bin.js"));
  } catch {
    /* 未安装则跳过 */
  }

  // npx 缓存：本机 DeepSeek Harness 就是从 ~/.npm/_npx/<hash>/node_modules 跑的。
  const npxRoot = path.join(homedir(), ".npm", "_npx");
  try {
    for (const entry of readdirSync(npxRoot)) {
      const bin = path.join(npxRoot, entry, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (existsSync(bin)) candidates.push(bin);
    }
  } catch {
    /* 没有 npx 缓存 */
  }

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (/\.(c|m)?js$/.test(candidate)) return { command: process.execPath, prefix: [candidate] };
    return { command: candidate, prefix: [] };
  }
  return null;
}

const dshLaunch = resolveDshLaunch();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 健康探测：DSH Web 对裸 "/" 回 401（未带 token），2xx–4xx 都算「进程活着」。 */
async function httpProbe(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
    return response.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isListing(portNum) {
  const status = await httpProbe(`http://127.0.0.1:${String(portNum)}/`);
  return typeof status === "number" && status >= 200 && status < 500;
}

async function waitForListening(portNum, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isListing(portNum)) return true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readState() {
  try {
    const parsed = JSON.parse(readText(STATE_PATH));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, void 0, 2)}\n`);
}

/** 从日志里挖出最新的 `dsh web: <url>` 行（dsh 启动时打印带 token 的 URL）。 */
function readTokenFromLog() {
  const lines = readText(LOG_PATH).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.startsWith("dsh web: ")) continue;
    const match = line.match(/dsh web: (\S+)/);
    if (!match) continue;
    try {
      const token = new URL(match[1]).searchParams.get(TOKEN_QUERY);
      if (token) return token;
    } catch {
      /* 坏行跳过 */
    }
  }
  return null;
}

function hasToken(origin) {
  try {
    return new URL(origin).searchParams.has(TOKEN_QUERY);
  } catch {
    return false;
  }
}

function stopPid(pid) {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
}

/**
 * 异步执行一条只读诊断命令。为什么不用 spawnSync：本脚本后面会 await 网络探测，
 * 在 libuv 线程池被 fetch 占用时同步子进程会拿不到句柄（macOS 上会 EAGAIN 直接失败）。
 */
function execText(command, argv) {
  return new Promise((resolve) => {
    execFile(command, argv, { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error) {
        trace("exec.failed", { command, error: error.message });
        resolve("");
        return;
      }
      resolve(`${stdout || ""}`);
    });
  });
}

/**
 * 只认自己的进程：进程环境里必须带着本 App 的 DSH_HOME，避免误杀别人的 dsh（3080 / 6767）。
 * 注意别用命令行判断——`dsh web --port ...` 的命令行里没有 DSH_HOME，只有环境里有。
 */
async function pidBelongsToThisApp(pid) {
  if (!isPidAlive(pid)) return false;
  const text = await execText("ps", ["eww", "-o", "command=", "-p", String(pid)]);
  return text.includes(`DSH_HOME=${DSH_HOME}`);
}

/** 端口是谁在听（空闲时返回 null）。 */
async function listenerPidOf(portNum) {
  const text = await execText("lsof", ["-nP", `-iTCP:${String(portNum)}`, "-sTCP:LISTEN", "-t"]);
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

/** 指纹：DSH_HOME / profile / 端口 / 插件清单任一变化都要重拉。 */
function fingerprintOf() {
  const deps = (() => {
    try {
      return JSON.stringify(JSON.parse(readText(path.join(PROFILE_DIR, "package.json")))?.dependencies ?? {});
    } catch {
      return "";
    }
  })();
  return JSON.stringify({
    dshHome: DSH_HOME,
    profile: DSH_PROFILE,
    port,
    dshCli: dshLaunch ? (dshLaunch.prefix[0] ?? dshLaunch.command) : null,
    deps,
    pluginPresent: existsSync(path.join(PROFILE_DIR, "node_modules", "ds-bot")),
  });
}

// 独立 DSH_HOME 意味着 `.credentials.yaml` 里没有 API key。`dsh-credentials-local`
// 的 `resolve()` 第一层就是进程环境（source: "env"，优先级高于文件），所以把启动
// 环境里的凭证透传进子进程即可，无需把 key 落盘。
const CREDENTIAL_ENV_PATTERN = /^(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|.*_API_KEY|.*_TOKEN)$/;

function inheritedCredentials() {
  /** @type {Record<string, string>} */
  const picked = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.length > 0 && CREDENTIAL_ENV_PATTERN.test(key)) {
      picked[key] = value;
    }
  }
  return picked;
}

function buildSupervisedPlan(warnings, fingerprintValue) {
  const credentials = inheritedCredentials();
  if (Object.keys(credentials).length === 0) {
    warnings.push(
      "启动环境里没有 *_API_KEY/*_TOKEN：隔离 DSH_HOME 的 .credentials.yaml 也不含 API key，DS Bot 发消息会报 MISSING_CREDENTIAL。可用 Web 端「管理模型」页写入，或在启动宿主前导出 DEEPSEEK_API_KEY。",
    );
  }
  return {
    command: dshLaunch.command,
    args: [...dshLaunch.prefix, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"],
    cwd: WEB_CWD,
    env: {
      DSH_HOME,
      DSH_TELEMETRY_DISABLED: "1",
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}`,
      ...credentials,
    },
    fingerprint: fingerprintValue,
    healthUrl: `http://127.0.0.1:${String(port)}/`,
    port,
    launchMode: "dev",
    // dsh web 就绪后 stdout 打印 `dsh web: <带 token 的 URL>`，宿主据此取 token。
    iframeOriginStderrPrefix: "dsh web: ",
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function emit(payload) {
  console.log(JSON.stringify(payload));
}

async function main() {
  const warnings = [];
  mkdirSync(DSH_HOME, { recursive: true });
  mkdirSync(WEB_CWD, { recursive: true });

  if (!dshLaunch) {
    emit({
      ok: false,
      error:
        "未找到 dsh CLI：请先装好 DeepSeek Harness（npx @deepseek-ai/dsh），或设置 DSH_BOT_DSH_CLI 指向 dsh 的 lib/bin.js",
      port,
    });
    process.exitCode = 1;
    return;
  }
  trace("dsh.resolve", { command: dshLaunch.command, entry: dshLaunch.prefix[0] ?? null });

  const pluginInstalled = existsSync(path.join(PROFILE_DIR, "node_modules", "ds-bot"));
  if (!pluginInstalled) {
    warnings.push(
      `profile ${DSH_PROFILE} 里没有 ds-bot 插件：请先执行 dsh plugin --profile ${DSH_PROFILE} add <ds-bot 源码目录>`,
    );
  }

  const fingerprintValue = fingerprintOf();

  if (args.supervised) {
    const plan = buildSupervisedPlan(warnings, fingerprintValue);
    trace("supervised.plan", { port, command: plan.command });
    emit({ ok: true, reused: false, plan, warnings, mode: "dev", fingerprint: fingerprintValue });
    return;
  }

  const state = readState();
  const recordedPid = typeof state?.pid === "number" ? state.pid : null;
  // 端口上真正在听的进程优先（state 可能落后，或上次是手工起的）；lsof 失灵时退回 state。
  const portHolder = await listenerPidOf(port);
  if (portHolder !== null) trace("port.holder", { port, pid: portHolder });
  else if (recordedPid !== null) trace("port.holder-unknown", { port, recordedPid });
  const statePid = portHolder ?? recordedPid;
  const alive = statePid !== null && isPidAlive(statePid);
  const listening = await isListing(port);
  const storedOrigin =
    typeof state?.origin === "string" && state.origin.startsWith("http") ? state.origin : null;
  const logToken = readTokenFromLog();
  const reusableOrigin = (() => {
    if (storedOrigin && hasToken(storedOrigin)) return storedOrigin;
    if (logToken) return `http://127.0.0.1:${String(port)}/?${TOKEN_QUERY}=${logToken}`;
    return null;
  })();

  // 复用分支：进程活 + 端口通 + 指纹没变 + 不强制重启 + 能拿到 token URL。
  if (!args.forceRestart && alive && listening && reusableOrigin) {
    const fpOk = !state?.fingerprint || state.fingerprint === fingerprintValue;
    if (fpOk) {
      trace("reuse", { port, pid: statePid });
      emit({
        ok: true,
        reused: true,
        port,
        pid: statePid,
        origin: reusableOrigin,
        warnings,
        dshHome: DSH_HOME,
        profile: DSH_PROFILE,
      });
      return;
    }
    trace("reuse-skipped", { reason: "fingerprint-changed" });
  }

  // 端口被占着但不是我们的进程：绝不误杀，直接报错让人换端口。
  const owned = listening ? await pidBelongsToThisApp(statePid) : false;
  trace("port.owned", { port, statePid, listening, owned });
  if (listening && !owned) {
    emit({
      ok: false,
      error: `端口 ${String(port)} 被其它进程占用（不是本 App 的 dsh web，pid=${String(statePid)}）；请换端口或先释放`,
      port,
    });
    process.exitCode = 1;
    return;
  }

  if (listening || (alive && statePid !== null)) {
    trace("stop-existing", { pid: statePid });
    stopPid(statePid);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && (await isListing(port))) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (await isListing(port)) {
      emit({ ok: false, error: `旧 dsh web（pid=${String(statePid)}）没有在 8s 内退出`, port });
      process.exitCode = 1;
      return;
    }
  }

  // 清掉旧日志，保证 token 解析只看到本次启动的那一行。
  try {
    rmSync(LOG_PATH, { force: true });
  } catch {
    /* 无所谓 */
  }

  const argv = [
    ...dshLaunch.prefix,
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-open",
  ];
  const logFd = openSync(LOG_PATH, "a");
  // 环境继承全部 process.env（已含宿主导出的凭证），再覆盖隔离 DSH_HOME。
  const child = spawn(dshLaunch.command, argv, {
    cwd: WEB_CWD,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ...inheritedCredentials(),
      DSH_HOME,
      DSH_TELEMETRY_DISABLED: "1",
    },
  });
  child.unref();
  closeSync(logFd);
  trace("spawn", { pid: child.pid ?? null, port, dshHome: DSH_HOME, logPath: LOG_PATH });

  const ready = await waitForListening(port, HEALTH_TIMEOUT_MS);
  if (!ready) {
    stopPid(child.pid);
    const tail = readText(LOG_PATH).trim().slice(-600);
    emit({
      ok: false,
      error: tail ? `dsh web 启动超时：${tail}` : "dsh web 启动超时（无日志）",
      port,
      logPath: LOG_PATH,
    });
    process.exitCode = 1;
    return;
  }

  // 端口通了还要等 dsh 打印 token 行（loader 跑完、connection 就绪后才打印）。
  const tokenDeadline = Date.now() + TOKEN_TIMEOUT_MS;
  let token = null;
  while (Date.now() < tokenDeadline) {
    token = readTokenFromLog();
    if (token) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!token) {
    emit({
      ok: false,
      error: `dsh web 已监听 ${String(port)} 但没拿到 token URL；详见 ${LOG_PATH}`,
      port,
    });
    process.exitCode = 1;
    return;
  }

  const origin = `http://127.0.0.1:${String(port)}/?${TOKEN_QUERY}=${token}`;
  writeState({
    fingerprint: fingerprintValue,
    port,
    pid: child.pid ?? null,
    origin,
    dshHome: DSH_HOME,
    profile: DSH_PROFILE,
    logPath: LOG_PATH,
    warnings,
    updatedAt: Date.now(),
  });

  emit({
    ok: true,
    reused: false,
    port,
    pid: child.pid ?? null,
    origin,
    warnings,
    dshHome: DSH_HOME,
    profile: DSH_PROFILE,
  });
}

main().catch((error) => {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error), port });
  process.exitCode = 1;
});
