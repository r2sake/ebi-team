// 「応答が返るまで無限に待つ」POST（承認 / 質問の long-poll）専用のクライアント。
//
// なぜ fetch を使わないか（2026-09-08 の実事象）:
//   Node の fetch（undici）は **headersTimeout の既定が 300 秒**で、応答ヘッダが
//   それまでに来ないと `fetch failed`（UND_ERR_HEADERS_TIMEOUT）で落ちる。
//   承認 UI は「ボスが答えるまで応答を返さない」設計なので、5 分放置しただけで
//   MCP 側が勝手に諦め、サーバ側の保留も接続断で破棄されていた
//   （master-chat.jsonl: question → 301,075ms 後に discarded ＋
//    `承認 UI へ到達できません: … fetch failed`）。
//   undici の dispatcher を差し替えるには undici を直接 import する必要があるが、
//   このリポジトリは undici を依存に持たない。node:http なら**既定でタイムアウトが無い**
//   ので、素の http.request で書くのが最小の解になる。
//
// 使う先は permission_prompt だけ（他のツールは従来どおり fetch で十分・短時間で返る）。

import { request as httpRequest } from "node:http";

export type LongPollResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * JSON を POST し、**応答が来るまで待ち続ける**（タイムアウトを掛けない）。
 * signal で中断されたら接続を切る＝サーバ側は保留を破棄する（従来と同じ合図）。
 * http 以外の URL（https 等）は扱えないので null を返し、呼び出し側が fetch へ落とす。
 */
export function postLongPoll(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<LongPollResult> | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "http:") return null;

  const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  return new Promise<LongPollResult>((resolve) => {
    let settled = false;
    const done = (r: LongPollResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.byteLength),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: unknown = undefined;
          try {
            data = text ? JSON.parse(text) : undefined;
          } catch {
            data = text;
          }
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const errMsg =
              data && typeof data === "object" && "error" in data
                ? String((data as { error: unknown }).error)
                : `HTTP ${status}`;
            done({ ok: false, error: errMsg });
            return;
          }
          done({ ok: true, data });
        });
      },
    );
    // ソケットのアイドルタイムアウトも掛けない（承認待ちは何時間でも続く）。
    req.setTimeout(0);
    req.on("error", (err) => {
      done({ ok: false, error: `制御APIへ接続できません（${url}）: ${(err as Error).message}` });
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        done({ ok: false, error: "要求が取り消されました" });
      } else {
        signal.addEventListener(
          "abort",
          () => {
            req.destroy();
            done({ ok: false, error: "要求が取り消されました" });
          },
          { once: true },
        );
      }
    }
    req.end(payload);
  });
}
