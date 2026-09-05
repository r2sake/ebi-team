// master チャット会話の JSONL 永続化（再接続・サーバ再起動後の snapshot 用）。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §8-R10
//
// 方針（既存 jsonlLog.ts の流儀を踏襲する）:
// - best-effort。書き込み失敗で会話を止めない（ログのために master を壊さない）。
// - 追記は直列化して行の混線を防ぐ。
// - サイズ上限を超えたら 1 世代だけローテートする（無限肥大の防止）。
// - **configure されるまでファイルへは書かない**（unit テストが勝手にファイルを作らないため）。
// - 読み出しは「末尾 N 件」だけ（起動時の snapshot 復元用）。全文はメモリに載せない。

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { MasterChatEnvelope } from "../../shared/protocol.ts";

/** 既定のローテート閾値（bytes）。1 会話ぶんの復元ができれば十分なので控えめに取る。 */
export const DEFAULT_CHAT_LOG_MAX_BYTES = 16 * 1024 * 1024;

/**
 * JSONL 1 行を MasterChatEnvelope へ復元する純関数。
 * 壊れた行・形が違う行は null（読み捨てる。復元の失敗で起動を止めない）。
 */
export function parseChatLogLine(line: string): MasterChatEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const seq = rec.seq;
  const ts = rec.ts;
  const event = rec.event;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  if (typeof event !== "object" || event === null) return null;
  if (typeof (event as Record<string, unknown>).kind !== "string") return null;
  return { seq, ts, event: event as MasterChatEnvelope["event"] };
}

/**
 * JSONL 本文（複数行）から末尾 limit 件を復元する純関数。
 * seq の昇順で返す（ファイルの並びをそのまま信用せず、seq で並べ直す）。
 */
export function parseChatLogTail(text: string, limit: number): MasterChatEnvelope[] {
  const out: MasterChatEnvelope[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const env = parseChatLogLine(lines[i]!);
    if (env) out.push(env);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** master チャットの会話ログ（1 インスタンス = 1 ファイル）。 */
export class ChatLog {
  private path: string | null = null;
  private writtenBytes = 0;
  /** 追記の直列化チェーン（行の混線防止）。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly maxBytes: number = DEFAULT_CHAT_LOG_MAX_BYTES) {}

  /** 出力先を設定する（null なら以降ファイルへ書かない＝メモリのみ）。 */
  configure(path: string | null): void {
    this.path = path;
    this.writtenBytes = 0;
    if (!path) return;
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const st = await stat(path).catch(() => null);
        this.writtenBytes = st?.size ?? 0;
      })
      .catch(() => {});
  }

  currentPath(): string | null {
    return this.path;
  }

  /** 1 件追記する（await 不要・best-effort）。 */
  append(env: MasterChatEnvelope): void {
    const path = this.path;
    if (!path) return;
    const buf = `${JSON.stringify(env)}\n`;
    this.chain = this.chain
      .then(async () => {
        if (this.writtenBytes + buf.length > this.maxBytes) {
          await rename(path, `${path}.1`).catch(() => {});
          this.writtenBytes = 0;
        }
        await appendFile(path, buf, "utf8");
        this.writtenBytes += buf.length;
      })
      .catch((err) => {
        console.warn("[master-chat] 会話ログの書き込みに失敗:", (err as Error).message);
      });
  }

  /**
   * 末尾 limit 件を読み出す（サーバ再起動後の snapshot 復元用）。
   * ファイルが無い/壊れている場合は空配列（起動を止めない）。
   */
  async tail(limit: number): Promise<MasterChatEnvelope[]> {
    const path = this.path;
    if (!path) return [];
    try {
      const text = await readFile(path, "utf8");
      return parseChatLogTail(text, limit);
    } catch {
      return [];
    }
  }

  /** テスト用: 追記チェーンの完了を待つ。 */
  flush(): Promise<void> {
    return this.chain;
  }
}
