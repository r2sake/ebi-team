// 制御 API のエビごとのトークン（セキュアモード）を載せるヘッダ名。
// サーバ（index.ts）・制御 MCP（control-server.ts）・hook（secure-hook.ts）で共有する。
// 値は env EBI_CONTROL_TOKEN（サーバが spawn 時にエビごとに発行して pty env へ入れる）。
export const CONTROL_TOKEN_HEADER = "x-ebi-control-token";
