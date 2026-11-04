// ボスの TODO パネルの表示ロジック（DOM を持たない純関数。unit テスト対象）。
// 設計: docs/plans/boss-todo-plan.md §4

import type { TodoItem, TodoKind } from "../shared/protocol.ts";

/** 種類ごとのアイコンと呼び名。 */
export const TODO_KIND_LABEL: Record<TodoKind, { icon: string; name: string }> = {
  question: { icon: "❓", name: "質問" },
  permission: { icon: "🔐", name: "許可" },
  action: { icon: "🛠", name: "作業" },
};

/** トップバーのボタンの文言（件数入り）。 */
export function todoButtonText(count: number): string {
  return `📋 TODO ${count}`;
}

/** ボタンの title（種類ごとの内訳）。0 件なら「TODO はありません」。 */
export function todoBreakdown(items: readonly Pick<TodoItem, "kind">[]): string {
  if (items.length === 0) return "ボスの TODO はありません";
  const parts: string[] = [];
  for (const kind of Object.keys(TODO_KIND_LABEL) as TodoKind[]) {
    const n = items.filter((it) => it.kind === kind).length;
    if (n > 0) parts.push(`${TODO_KIND_LABEL[kind].name} ${n}`);
  }
  return `ボスの TODO: ${parts.join("・")}`;
}

/** 経過時間の短い表記（「たった今」「5 分前」「3 時間前」「2 日前」）。 */
export function ageLabel(createdAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (sec < 60) return "たった今";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 時間前`;
  return `${Math.floor(hour / 24)} 日前`;
}

/** 一覧の 1 行に添える「エビ / 案件」。どちらも無ければ空文字。 */
export function todoMetaText(item: Pick<TodoItem, "ebi" | "project">): string {
  return [item.ebi, item.project].filter((v): v is string => !!v).join(" / ");
}

/** 「✓ 対応した」を出すか（質問は答えで返すので出さない。許可・作業だけ）。 */
export function showsDoneButton(item: Pick<TodoItem, "kind">): boolean {
  return item.kind !== "question";
}

/** 「回答して送る」を押せるか（選択か補足のどちらかがある）。 */
export function canSendAnswer(choice: string | null, text: string): boolean {
  return !!choice || text.trim() !== "";
}
