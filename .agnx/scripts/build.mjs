#!/usr/bin/env node
// 场景：DS Bot 子应用胶水打包 — esbuild 打 CJS dist（宿主侧提供 react / app-sdk）。
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const entry = path.join(appRoot, "src/index.ts");
const outFile = path.join(appRoot, "dist/index.js");

if (!existsSync(entry)) {
  console.error("[ds-bot agnx build] 找不到 src/index.ts");
  process.exit(1);
}

const require = createRequire(import.meta.url);
let esbuild = null;
let resolvedFrom = "";
// esbuild 只作为本地构建工具：优先用 Agnx 仓里已装的那份，避免在 App 目录里落地 node_modules。
const candidates = [
  // 宿主仓库位置：优先环境变量，其次按 app 根相对推导（外部克隆通常两者都不可用，
  // 此时走下面的 require("esbuild") 兜底，由 .agnx/ 自己的 devDependencies 提供）。
  process.env.AGNX_MONOREPO_ROOT && path.join(process.env.AGNX_MONOREPO_ROOT, "node_modules/esbuild"),
  path.resolve(agnxRoot, "../../../Documents/github/agnx/node_modules/esbuild"),
  path.join(agnxRoot, "../node_modules/esbuild"),
].filter((p) => typeof p === "string" && p.length > 0);
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    esbuild = require(candidate);
    resolvedFrom = candidate;
    break;
  }
}
if (!esbuild) {
  try {
    esbuild = require("esbuild");
    resolvedFrom = "esbuild(cwd)";
  } catch {
    console.error("[ds-bot agnx build] 找不到 esbuild：请在 agnx 仓 npm i，或本目录 npm i -D esbuild");
    process.exit(1);
  }
}

mkdirSync(path.dirname(outFile), { recursive: true });

await esbuild.build({
  absWorkingDir: appRoot,
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "cjs",
  platform: "neutral",
  mainFields: ["module", "main", "browser"],
  conditions: ["import", "require", "default"],
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: false,
  minify: true,
  external: [
    "react",
    "react-native",
    "react/jsx-runtime",
    "@agnx-lab/app-sdk",
    "react-native-unistyles",
  ],
  logLevel: "info",
});

console.log(`[ds-bot agnx build] ok → dist/index.js (via ${resolvedFrom})`);
