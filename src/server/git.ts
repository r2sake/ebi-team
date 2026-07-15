// git worktree 操作ユーティリティ。
// すべての git 呼び出しは execFile（シェル非経由・引数配列渡し）で行い、
// パス/ブランチ名経由のコマンドインジェクションを防ぐ。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";

const execFileAsync = promisify(execFile);

/** git コマンドを repo を cwd として実行する（シェル非経由）。 */
async function git(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  // `-C <repo>` で対象 repo を固定する。
  return execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

/** 指定パスが git 管理下の作業ツリーかどうか。 */
export async function isInsideWorkTree(repo: string): Promise<boolean> {
  try {
    const { stdout } = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** repo のトップレベル（作業ツリーのルート）絶対パスを返す。 */
export async function topLevel(repo: string): Promise<string> {
  const { stdout } = await git(repo, ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

/** 指定ブランチがローカルに既存かどうか。 */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    // refs/heads/<branch> を厳密に検証（--verify は存在しなければ非 0 終了）。
    await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * ブランチ名を worktree ディレクトリ名に使える形へサニタイズする。
 * 例: "ebi/ebi-1" → "ebi-ebi-1"。英数・ハイフン・アンダースコア以外を `-` に畳む。
 */
export function safeBranchDirName(branch: string): string {
  const cleaned = branch
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return cleaned || "branch";
}

export interface WorktreeResult {
  /** 生成（または再利用）した worktree の絶対パス。 */
  worktreePath: string;
  /** worktree の元 repo（トップレベル）の絶対パス。 */
  repoTop: string;
  /** 実際に使ったブランチ名。 */
  branch: string;
  /** 既存ブランチ/既存ディレクトリを再利用した場合のメモ（notice 表示用、なければ null）。 */
  reused: string | null;
}

/**
 * repo 直下の `.worktrees/<safe-branch>/` に worktree を作成する。
 * - repo が git 管理下でなければ throw。
 * - 同名ディレクトリが既に worktree として存在すれば再利用（reused を埋める）。
 * - ブランチ既存なら `-b` 無しで add、新規なら `-b <branch>`（ベースは現在の HEAD）。
 */
export async function addWorktree(repo: string, branch: string): Promise<WorktreeResult> {
  if (!(await isInsideWorkTree(repo))) {
    throw new Error(`git 管理下のリポジトリではありません: ${repo}`);
  }
  const repoTop = await topLevel(repo);
  const dirName = safeBranchDirName(branch);
  const worktreePath = resolve(join(repoTop, ".worktrees", dirName));

  // 既に同パスが worktree として登録済みなら再利用する。
  const existing = await listWorktreePaths(repoTop);
  if (existing.includes(worktreePath)) {
    return {
      worktreePath,
      repoTop,
      branch,
      reused: `既存 worktree を再利用しました: ${worktreePath}`,
    };
  }

  const exists = await branchExists(repoTop, branch);
  const args = exists
    ? ["worktree", "add", worktreePath, branch] // 既存ブランチをチェックアウト。
    : ["worktree", "add", "-b", branch, worktreePath]; // 新規ブランチを HEAD から作成。

  try {
    await git(repoTop, args);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
    throw new Error(`worktree add 失敗: ${stderr.trim()}`);
  }

  return {
    worktreePath,
    repoTop,
    branch,
    reused: exists ? `既存ブランチ ${branch} をチェックアウトしました` : null,
  };
}

/** repo に登録済みの worktree 絶対パス一覧を返す。 */
async function listWorktreePaths(repo: string): Promise<string[]> {
  try {
    const { stdout } = await git(repo, ["worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.push(resolve(line.slice("worktree ".length).trim()));
      }
    }
    return paths;
  } catch {
    return [];
  }
}

export interface RemoveResult {
  removed: boolean;
  /** removed=false のときの理由（未コミット変更等）。 */
  reason: string | null;
}

/**
 * worktree を remove する。未コミット変更等で失敗した場合は **force しない**。
 * データ保護を優先し、残置したうえで理由を返す（removed=false）。
 */
export async function removeWorktree(repoTop: string, worktreePath: string): Promise<RemoveResult> {
  try {
    await git(repoTop, ["worktree", "remove", worktreePath]);
    return { removed: true, reason: null };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
    return { removed: false, reason: stderr.trim() };
  }
}
