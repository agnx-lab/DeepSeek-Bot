/**
 * 场景：DS Bot 面板 — 把 ds-bot 的 dsh web 整页贴边嵌进 Agnx Tab。
 *
 * 结构极简：一个铺满的 guest 容器 + 首帧品牌遮罩 + 错误层。
 * Tab 须贴边满铺：禁止外层再包带 padding / 背景色的容器（否则就不是 edge-to-edge）。
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactElement,
} from "react";
import type { WorkspaceAppBrandLogoLoaderPanelProps, WorkspaceAppHostApi } from "@agnx-lab/app-sdk";

const APP_ID = "ds-bot";
const APP_TITLE = "DS Bot";
const PANEL_ID = "ds-bot.main";
const OPEN_COMMAND_ID = "ds-bot.open";
const ENSURE_TOOL_REL = ".agnx/tools/ensure-ds-bot.mjs";
/** 与 manifest.sidecar.defaultPort 一致：避开 3080（用户自己的 DSH）与 6767（Agnx 守护进程）。 */
const DEFAULT_PORT = "13080";

const WEB_ROOT_STYLE: CSSProperties = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  backgroundColor: "transparent",
};

const GUEST_HOST_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

const BOOT_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9, 9, 11)",
};

const ERROR_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 3,
  display: "flex",
  flexDirection: "column",
  background: "rgba(9,9,11,0.88)",
};

const ERROR_FALLBACK_STYLE: CSSProperties = {
  ...ERROR_LAYER_STYLE,
  alignItems: "center",
  justifyContent: "center",
  color: "#a1a1aa",
  padding: 24,
  textAlign: "center",
};

let boundHost: WorkspaceAppHostApi | null = null;

function getHost(): WorkspaceAppHostApi {
  if (!boundHost) {
    throw new Error(`${APP_TITLE} host 未绑定`);
  }
  return boundHost;
}

export function bindDsBotHost(host: WorkspaceAppHostApi): void {
  boundHost = host;
}

export function DsBotPanel(): ReactElement {
  const guestHostRef = useRef<HTMLDivElement | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = getHost();
    if (!host.guest?.mount) {
      setBooting(false);
      setError("宿主未提供 host.guest.mount（需升级 Agnx）");
      return;
    }
    const container = guestHostRef.current;
    if (!container) return;

    const unmount = host.guest.mount({
      container,
      ensureTool: ENSURE_TOOL_REL,
      ensureArgs: ["--port", DEFAULT_PORT],
      // dsh web 要跑插件装载 + 首屏 client 模块编译，宽限给到 3 分钟。
      timeoutMs: 180_000,
      // 首帧品牌遮罩由本面板自己铺（见下），避免与宿主遮罩叠成双层闪黑。
      bootOverlay: false,
      onReady: () => {
        setError(null);
        window.setTimeout(() => setBooting(false), 320);
      },
      onError: (detail) => {
        setBooting(false);
        setError(`${detail.code}: ${detail.message}`);
      },
    });
    return unmount;
  }, []);

  const BrandPanel = getHost().ui?.BrandLogoLoaderPanel as
    | ComponentType<WorkspaceAppBrandLogoLoaderPanelProps>
    | undefined;

  return (
    <div style={WEB_ROOT_STYLE} aria-label={`${APP_TITLE} panel`}>
      <div
        ref={guestHostRef}
        data-agnx-guest-surface-host="true"
        data-testid={`workspace-mini-app-${APP_ID.replace(/\./g, "-")}-root`}
        style={GUEST_HOST_STYLE}
      />
      {booting && !error && BrandPanel ? (
        <div data-agnx-guest-boot-overlay="true" style={BOOT_LAYER_STYLE} role="status">
          <BrandPanel title={`正在启动 ${APP_TITLE}…`} testID="ds-bot-boot-overlay" />
        </div>
      ) : null}
      {booting && !error && !BrandPanel ? (
        <div data-agnx-guest-boot-overlay="true" style={ERROR_FALLBACK_STYLE} role="status">
          {`正在启动 ${APP_TITLE}…`}
        </div>
      ) : null}
      {error && BrandPanel ? (
        <div style={ERROR_LAYER_STYLE} role="alert">
          <BrandPanel
            title={error}
            description="打开命令面板 → DS Bot → 详情，复制 Guest Surface 贴给 AI。"
            testID="ds-bot-mount-error"
          />
        </div>
      ) : null}
      {error && !BrandPanel ? (
        <div style={ERROR_FALLBACK_STYLE} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function activate(host: WorkspaceAppHostApi): () => void {
  bindDsBotHost(host);
  const disposers: Array<() => void> = [];

  disposers.push(
    host.registerMiniApp({
      id: PANEL_ID,
      appId: APP_ID,
      title: APP_TITLE,
      component: DsBotPanel,
      // 客服端整个 UI 都在 iframe 里，桌面端要把快捷键转发进子框架（含 ⌘K / Esc / ⌘A）。
      iframeShortcutCapture: true,
      isolation: {
        mode: "iframe",
        sidecarTools: [ENSURE_TOOL_REL],
        note: "跨域文档 + 独立 DSH_HOME 的 dsh web 实例（端口 13080）；长任务走 sidecarTools 白名单",
      },
    }),
  );

  disposers.push(
    host.registerCommand({
      id: OPEN_COMMAND_ID,
      appId: APP_ID,
      title: APP_TITLE,
      run: (context) => {
        host.openSubAppTab({
          appId: APP_ID,
          panelId: PANEL_ID,
          serverId: context?.serverId,
          workspaceId: context?.workspaceId,
          currentPathname: context?.currentPathname,
        });
      },
    }),
  );

  return () => {
    for (const d of disposers.toReversed()) d();
  };
}
