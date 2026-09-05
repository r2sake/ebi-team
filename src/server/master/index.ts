// master 頭脳（MasterBrain）の公開窓口。
// 呼び出し側（PR-M2 の MasterSession）はここ以外から個別実装を import しない。

export * from "./brain.ts";
export * from "./claudeArgs.ts";
export * from "./claudeEvents.ts";
export { ClaudeHeadlessBrain, CLAUDE_BRAIN_CAPABILITIES } from "./claudeBrain.ts";
export { CodexHeadlessBrain, CODEX_BRAIN_CAPABILITIES } from "./codexBrain.ts";

import {
  IMPLEMENTED_MASTER_BRAIN_IDS,
  MasterBrainNotImplementedError,
  type MasterBrain,
  type MasterBrainId,
} from "./brain.ts";
import { ClaudeHeadlessBrain, type ClaudeHeadlessBrainOptions } from "./claudeBrain.ts";
import { CodexHeadlessBrain } from "./codexBrain.ts";

/** 未実装 id を黙って claude に落とさない（既存 resolveBackend と同じ流儀）。 */
export function isImplementedMasterBrain(id: MasterBrainId): boolean {
  return IMPLEMENTED_MASTER_BRAIN_IDS.includes(id);
}

/**
 * id から MasterBrain を作る。
 * 実装が無い id（gemini / agy）は明示エラー。codex は stub を返す（メソッド呼び出しで明示エラー）。
 */
export function createMasterBrain(
  id: MasterBrainId,
  opts: ClaudeHeadlessBrainOptions = {},
): MasterBrain {
  switch (id) {
    case "claude":
      return new ClaudeHeadlessBrain(opts);
    case "codex":
      return new CodexHeadlessBrain();
    default:
      throw new MasterBrainNotImplementedError(id, "createMasterBrain");
  }
}
