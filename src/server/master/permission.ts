// 承認 / 質問（permission / question）の受け口と保留管理。
//
// 設計書: docs/design/master-chat-ui-2026-09-05.md §0.6 / §9 PR-M5
// 実測 SoT: docs/poc/master-headless-poc-2026-09-05.md §6（PR-M5 の追記）
//
// claude ヘッドレスの承認は **stdin/stdout ではなく MCP ツール経由**で来る:
//   claude --permission-prompt-tool mcp__ebi-control__permission_prompt
//     → ebi-control（stdio MCP）が `POST /control/chat-permission` を叩く
//     → サーバが pending を UI へ出し、ボスが答えるまで **HTTP 応答を返さない**
//     → 返した allow/deny がそのままツールの実行可否になる
//
// PR-M5 の実測でわかった 2 点（設計書 §0.6 の N / O）:
//  N) 承認要求は **claude の NDJSON には一切現れない**（tool_use は出るが、承認の往復は
//     MCP 側で完結する）。つまり保留の供給源はこのブローカだけで、claudeEvents.ts の
//     正規化からは permission イベントは出ない。
//  O) **AskUserQuestion も同じ承認ツールを通る**。答えを返す口は
//     `{"behavior":"allow","updatedInput":{...input, answers:{"<質問文>":"<回答>"}}}`
//     で、これを返すと claude 側のツール結果が
//     `Your questions have been answered: "<質問文>"="<回答>"` になる。
//     answers を付けずに allow すると `The user did not answer the questions.` になる
//     （＝質問を「許可」しただけでは答えたことにならない）。
//
// このファイルは I/O を持たない（HTTP も spawn もしない）。保留の台帳と
// 「回答 → claude 方言の決定」への写像だけを持つ。

/** `--permission-prompt-tool` 経由で届く 1 件の要求。 */
export interface MasterPermissionRequest {
  toolName: string;
  input: unknown;
  /** claude の tool_use_id（あれば UI のツールバブルと突き合わせられる）。 */
  toolUseId: string | null;
}

/** claude へ返す決定（ツール結果の JSON 本文そのもの）。 */
export type MasterPermissionDecision =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

/** ボスが UI で選んだ内容。 */
export interface MasterAnswer {
  /** 承認（permission）の可否。 */
  allow?: boolean;
  /** 質問（question）で選んだ選択肢ラベル。 */
  choice?: string[];
  /** 自由入力（「その他」）。choice と併用できる。 */
  note?: string;
}

/** 保留が解けた理由。UI のバブル表示に使う。 */
export type PermissionOutcome = "allowed" | "denied" | "discarded";

/** claude 組込みの質問ツール名（MCP 経由ではないので完全一致で判定する）。 */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/** 既定の承認ツール名（`--permission-prompt-tool` に渡す MCP ツールの完全名）。 */
export const MASTER_PERMISSION_PROMPT_TOOL = "mcp__ebi-control__permission_prompt";

/** AskUserQuestion の input.questions[i] を正規化したもの。 */
export interface ParsedQuestion {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multi: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * AskUserQuestion の input を質問配列へ正規化する純関数。
 * 形が想定外（questions が無い/空）なら null を返す＝**通常の承認として扱う**
 *（黙って落とさない・勝手に allow しない）。
 */
export function parseAskUserQuestionInput(input: unknown): ParsedQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const out: ParsedQuestion[] = [];
  for (const q of input.questions) {
    if (!isRecord(q)) continue;
    const options = Array.isArray(q.options)
      ? q.options.filter(isRecord).map((o) => ({
          label: String(o.label ?? ""),
          ...(typeof o.description === "string" ? { description: o.description } : {}),
        }))
      : [];
    out.push({
      header: String(q.header ?? ""),
      question: String(q.question ?? ""),
      options,
      multi: q.multiSelect === true,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * 選択肢 + 自由入力 → claude へ渡す 1 本の回答文字列。
 * 複数選択は読点ではなく `, ` で連結する（claude 側は文字列としてしか見ないため、
 * ラベルの区切りが視認できれば十分）。両方空なら空文字（＝未回答とは区別しない）。
 */
export function formatAnswerText(answer: MasterAnswer): string {
  const parts = (answer.choice ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  const note = (answer.note ?? "").trim();
  if (note) parts.push(note);
  return parts.join(", ");
}

/**
 * 質問への回答を claude 方言の decision へ写す純関数（実測 §0.6-O）。
 * `updatedInput` に元の input をそのまま載せ、`answers` を **質問文をキー**にして足す。
 */
export function buildQuestionDecision(
  input: unknown,
  questions: readonly ParsedQuestion[],
  answers: readonly (MasterAnswer | null)[],
): MasterPermissionDecision {
  const map: Record<string, string> = {};
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    map[q.question] = formatAnswerText(a);
  });
  const base = isRecord(input) ? input : {};
  return { behavior: "allow", updatedInput: { ...base, answers: map } };
}

/** ブローカが外へ知らせる出来事（brain が MasterEvent へ写す）。 */
export interface PermissionBrokerHandlers {
  /** 承認待ちが 1 件立った。 */
  onPermission(ev: { id: string; toolName: string; input: unknown }): void;
  /** 質問待ちが 1 件立った（AskUserQuestion の questions[i] ごとに 1 回）。 */
  onQuestion(ev: {
    id: string;
    header: string;
    question: string;
    options: { label: string; description?: string }[];
    multi: boolean;
  }): void;
  /** 保留 1 件が解けた（回答・拒否・破棄）。UI のボタンを畳むために使う。 */
  onSettled(ev: { id: string; outcome: PermissionOutcome; answer: string | null }): void;
  /** 運用者に見せる通知（破棄など）。 */
  onNotice(text: string): void;
}

/**
 * 同じ reqId で待っている HTTP 呼び出し 1 本ぶん。
 *
 * 同一 tool_use_id の要求が 2 回届くことが実際にある（2026-09-08 の実事象。
 * MCP 側の permission_prompt が 29ms 差で 2 回 `POST /control/chat-permission` を投げた）。
 * 台帳は reqId ごとに 1 件だけ持ち、待ち手だけを束ねる。
 */
interface PendingWaiter {
  settle(decision: MasterPermissionDecision): void;
  /** この待ち手の HTTP 接続が切れたか（abort 済み）。 */
  gone: boolean;
}

interface PendingRequest {
  /** 質問なら questions、承認なら null。 */
  questions: ParsedQuestion[] | null;
  input: unknown;
  toolName: string;
  /** 質問の場合は questions と同じ長さ。承認は長さ 1。null は未回答。 */
  answers: (MasterAnswer | null)[];
  /** 各スロットの UI 上の id（承認は [reqId]、質問は [reqId#0, …]）。 */
  slotIds: string[];
  /** 決定を返す先（同一 reqId の重複要求ぶんだけ増える）。 */
  waiters: PendingWaiter[];
  /** 既に決着済みか（多重 settle を防ぐ）。 */
  done: boolean;
}

/**
 * 承認 / 質問の保留台帳。
 *
 * タイムアウトは**持たない**（ボス裁定: 未応答は待ち続ける・自動拒否しない）。
 * 保留が消えるのは「ボスが答えた」「HTTP 接続が切れた（claude が中断した）」
 * 「プロセスが終わった / 新しい会話 / サーバが落ちた」の 3 系統だけ。
 */
export class PermissionBroker {
  private readonly requests = new Map<string, PendingRequest>();
  /** slotId → reqId の逆引き。 */
  private readonly slotOwner = new Map<string, string>();
  private counter = 0;

  constructor(private readonly handlers: PermissionBrokerHandlers) {}

  /** 未応答スロットの件数（UI のスティッキーバー用）。 */
  get pendingCount(): number {
    return this.slotOwner.size;
  }

  /** 未応答スロットの id 一覧（テスト・復元用）。 */
  pendingIds(): string[] {
    return [...this.slotOwner.keys()];
  }

  /**
   * 承認要求を受け付ける。**ボスが答えるまで resolve しない**。
   * signal（HTTP 接続の切断＝claude 側の中断）で abort されたら deny で畳む。
   */
  request(req: MasterPermissionRequest, signal?: AbortSignal): Promise<MasterPermissionDecision> {
    this.counter += 1;
    // tool_use_id があればそれを使う（UI のツールバブルと同じ id で並ぶ）。
    const reqId = req.toolUseId && req.toolUseId.length > 0 ? req.toolUseId : `perm-${this.counter}`;

    return new Promise<MasterPermissionDecision>((resolve) => {
      const waiter: PendingWaiter = { settle: resolve, gone: false };

      // 同じ reqId が既に保留中なら**新規登録しない**（UI へ二重に出さない）。
      // 待ち手だけを足して、決定は両方の HTTP へ同じものを返す。
      const known = this.requests.get(reqId);
      if (known && !known.done) {
        known.waiters.push(waiter);
        this.bindAbort(reqId, known, waiter, signal);
        return;
      }

      const questions =
        req.toolName === ASK_USER_QUESTION_TOOL ? parseAskUserQuestionInput(req.input) : null;
      const slotIds = questions ? questions.map((_, i) => `${reqId}#${i}`) : [reqId];
      const entry: PendingRequest = {
        questions,
        input: req.input,
        toolName: req.toolName,
        answers: slotIds.map(() => null),
        slotIds,
        waiters: [waiter],
        done: false,
      };
      this.requests.set(reqId, entry);
      for (const id of slotIds) this.slotOwner.set(id, reqId);

      if (this.bindAbort(reqId, entry, waiter, signal)) return; // 既に切れていた

      if (questions) {
        questions.forEach((q, i) => {
          this.handlers.onQuestion({
            id: slotIds[i]!,
            header: q.header,
            question: q.question,
            options: q.options,
            multi: q.multi,
          });
        });
      } else {
        this.handlers.onPermission({ id: reqId, toolName: req.toolName, input: req.input });
      }
    });
  }

  /**
   * 待ち手 1 本の HTTP 切断を保留へ結びつける。
   *
   * **全部の待ち手が切れたときにだけ**保留を破棄する（1 本が諦めただけでボスの
   * 回答待ちを畳むと、生きている方の要求も道連れになる）。
   * 既に abort 済みで保留ごと畳んだ場合は true を返す。
   */
  private bindAbort(
    reqId: string,
    entry: PendingRequest,
    waiter: PendingWaiter,
    signal: AbortSignal | undefined,
  ): boolean {
    if (!signal) return false;
    const onAbort = (): void => {
      if (entry.done || waiter.gone) return;
      waiter.gone = true;
      // この待ち手には即座に返す（相手はもう聞いていないが Promise を宙に浮かせない）。
      waiter.settle({ behavior: "deny", message: "要求が取り消されました" });
      if (entry.waiters.some((w) => !w.gone)) return; // 他の接続はまだ生きている
      this.finish(reqId, { behavior: "deny", message: "要求が取り消されました" }, "discarded", null);
    };
    if (signal.aborted) {
      onAbort();
      return entry.done || waiter.gone;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return false;
  }

  /**
   * ボスの応答。未知の id は明示エラー（黙って捨てると UI が永久に待つ）。
   * 質問は**全スロットが埋まったとき**にだけ claude へ返す。
   */
  answer(slotId: string, answer: MasterAnswer): void {
    const reqId = this.slotOwner.get(slotId);
    if (!reqId) throw new Error(`未応答の承認/質問が見つかりません: ${slotId}`);
    const entry = this.requests.get(reqId);
    if (!entry || entry.done) throw new Error(`承認/質問は既に解決済みです: ${slotId}`);
    const index = entry.slotIds.indexOf(slotId);
    if (index < 0) throw new Error(`承認/質問のスロットが不正です: ${slotId}`);

    if (!entry.questions) {
      // 承認（permission）: allow が明示されていなければ拒否として扱う（fail-safe）。
      const allow = answer.allow === true;
      const decision: MasterPermissionDecision = allow
        ? { behavior: "allow", updatedInput: entry.input ?? {} }
        : {
            behavior: "deny",
            message: (answer.note ?? "").trim() || "ボスが拒否しました",
          };
      this.finish(reqId, decision, allow ? "allowed" : "denied", allow ? "許可" : "拒否");
      return;
    }

    entry.answers[index] = answer;
    this.slotOwner.delete(slotId);
    this.handlers.onSettled({ id: slotId, outcome: "allowed", answer: formatAnswerText(answer) });
    if (entry.answers.some((a) => a == null)) return; // まだ残りの質問がある
    entry.done = true;
    this.requests.delete(reqId);
    settleAll(entry, buildQuestionDecision(entry.input, entry.questions, entry.answers));
  }

  /**
   * 全保留を破棄する（プロセス終了 / 新しい会話 / サーバ停止）。
   * claude 側には deny を返してツールを実行させない。破棄した件数を返す。
   */
  discardAll(reason: string): number {
    const ids = [...this.requests.keys()];
    for (const reqId of ids) {
      this.finish(reqId, { behavior: "deny", message: reason }, "discarded", null);
    }
    if (ids.length > 0) {
      this.handlers.onNotice(`未応答の承認/質問 ${ids.length} 件を破棄しました（${reason}）`);
    }
    return ids.length;
  }

  private finish(
    reqId: string,
    decision: MasterPermissionDecision,
    outcome: PermissionOutcome,
    answer: string | null,
  ): void {
    const entry = this.requests.get(reqId);
    if (!entry || entry.done) return;
    entry.done = true;
    this.requests.delete(reqId);
    for (const id of entry.slotIds) {
      // 既に答え終わったスロット（質問の一部）は二重に settled を出さない。
      if (!this.slotOwner.delete(id)) continue;
      this.handlers.onSettled({ id, outcome, answer });
    }
    settleAll(entry, decision);
  }
}

/** 同じ reqId で待っている全 HTTP 呼び出しへ同じ決定を返す。 */
function settleAll(entry: PendingRequest, decision: MasterPermissionDecision): void {
  for (const w of entry.waiters) {
    if (w.gone) continue; // 既に切断で返してある
    w.gone = true;
    w.settle(decision);
  }
}
