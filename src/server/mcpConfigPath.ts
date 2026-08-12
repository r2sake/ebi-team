// 役割別 MCP config（ebi-control）のパス解決。
//
// 生成側（scripts/gen-master-mcp.mjs）は dev か本番かでファイル名を出し分ける:
//   npm run dev   → predev  → gen-master-mcp.mjs --dev → <role>-control.dev.mcp.json（tsx / src 起点）
//   npm start     → prestart→ gen-master-mcp.mjs       → <role>-control.mcp.json    （node / dist 起点）
// サーバ側も同じ規約で解決する必要がある。ここを config へ手書きしていた master が
// `.dev` 固定のまま npm start され、存在しないパスを指して claude が起動即死した
// （2026-08-12）。以降は生成側・参照側の規約をこの 1 ファイルに閉じ込める。

import { join } from "node:path";

/**
 * MCP config を自動解決する対象ロール。
 * 動的エビの権限ティア（roles.ts の EbiMcpRole = "engineer"）に加え、固定エビの master を含む。
 * master は動的エビの role ではないが、ファイル名規約は共通なのでここでまとめて扱う。
 */
export type McpConfigRole = "engineer" | "master";

/**
 * サーバが src（tsx 実行）から動いているかを __dirname 相当の文字列で判定する。
 * dist から動いている場合は本番用のファイル名を使う。
 */
export function isRunningFromSrc(dirName: string): boolean {
  return dirName.includes(join("src", "server"));
}

/** 役割別 MCP config の既定パスを組み立てる（baseDir は通常 process.cwd()）。 */
export function mcpConfigPathFor(
  role: McpConfigRole,
  opts: { fromSrc: boolean; baseDir: string },
): string {
  return join(
    opts.baseDir,
    ".ebi-team",
    opts.fromSrc ? `${role}-control.dev.mcp.json` : `${role}-control.mcp.json`,
  );
}
