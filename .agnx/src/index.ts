/**
 * 场景：DS Bot 子应用入口 — activate(host) 注册面板 / 打开命令。
 *
 * 为什么拆两个文件：index.ts 只做注册（宿主加载即执行，必须轻）；
 * panel.tsx 只做渲染 + host.guest.mount（含 React 依赖）。
 */
export { activate, bindDsBotHost, DsBotPanel } from "./panel";
