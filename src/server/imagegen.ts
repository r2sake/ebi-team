// imagegen エビ（画像生成役割）の依頼／報告様式（YAML）と、生成後の正規化コマンドの SoT。
//
// 位置づけ:
// - 依頼 `imagegen_job: v1`（master → imagegen）と報告 `imagegen_result: v1`（imagegen → master）の
//   様式を**このファイルだけ**で定義し、検証を純関数として提供する。役割プロンプト（稼働 config の
//   roles.imagegen.appendSystemPrompt）はこの様式を日本語で要約したものであり、食い違いが出たら
//   ここを SoT とする。設計は docs/design/imagegen-role-2026-09-05.md。
// - サーバ本体のランタイム経路には組み込まれていない（エビは LLM であり、YAML を読むのは
//   エビ自身）。人／master が投げる前に形を確かめるための検証器兼、様式の実行可能な仕様として置く。
//   CLI は scripts/imagegen-check.mjs（`npm run imagegen:check <file>`）。
//
// 依存はゼロ（Node 組込みすら使わない純粋モジュール）。YAML パーサも外部依存を足さずに、
// 本様式が使う部分集合（ブロックマップ／ブロックシーケンス／ブロックスカラ `|`／フローシーケンス）
// だけを自前で解く（parseSimpleYaml）。

// ===== 様式の定数 =====

/** 依頼／報告のバージョン文字列（先頭キーの値）。 */
export const IMAGEGEN_JOB_VERSION = "v1";
export const IMAGEGEN_RESULT_VERSION = "v1";

/** 1 ジョブの上限枚数（ボス裁定 2026-09-05: 6 枚で確定）。count の合計に対して効く。 */
export const MAX_IMAGES_PER_JOB = 6;

/** dest_root 既定値を job_id から作る（cwd からの相対パス）。 */
export function defaultDestRoot(jobId: string): string {
  return `tmp/images/${jobId}`;
}

/**
 * 報告で使える error_code の全集合。ACK 誤検知語（profiles.ts）と衝突しない語だけを採る
 * （初版の TOOL_UNAVAILABLE は英語パターンに一致した＝設計 §6.4 の実害）。
 *   GEN_TOOL_OFF  画像生成ツールがセッションに配られていない（プラン切れ／認証切れ）
 *   REFUSED       生成ポリシーで拒否された
 *   GEN_ERROR     ツールがエラー応答／出力が見当たらない
 *   RESIZE_ERROR  sips が失敗
 *   TOOL_MISSING  cwebp が無い（PNG のまま skipped）
 *   OVER_LIMIT    1 ジョブ 6 枚の上限を超えた分（生成しない）
 *   TIMEOUT       master 側の打ち切り（エビは自分では出さない）
 */
export const IMAGEGEN_ERROR_CODES = [
  "GEN_TOOL_OFF",
  "REFUSED",
  "GEN_ERROR",
  "RESIZE_ERROR",
  "TOOL_MISSING",
  "OVER_LIMIT",
  "TIMEOUT",
] as const;
export type ImagegenErrorCode = (typeof IMAGEGEN_ERROR_CODES)[number];

/** 報告の status 値。 */
export const IMAGEGEN_STATUSES = ["ok", "failed", "refused", "skipped"] as const;
export type ImagegenStatus = (typeof IMAGEGEN_STATUSES)[number];

/**
 * 認証／プラン起因（image_gen が配られていない・401）のときに、報告本文へ必ず含める一文
 * （ボス裁定 A5: 手順化はせず、master がボスへ渡せる 1 行にする）。
 * ACK 検知語（`(利用|使用)でき(ない|ません|ず)` 等）**と codex の fatalPatterns**（`codex login`
 * という並びが `起動エラー` 通知を誤って立てる）のどちらにも当たらないこと。
 * この 2 つは test/imagegen.test.ts が profiles.ts のパターンで機械照合している。
 * 実際に踏んだ罠: 初版は「`codex login` のやり直しを依頼」と書いており、役割プロンプトのエコーが
 * fatalPatterns の /(codex login|Not logged in|Please (re)?login)/i に一致して、正常起動なのに
 * 「起動エラー: codex がログインを要求しています」が出た（2026-09-05 スモークで観測）。
 */
export const CODEX_RELOGIN_HINT =
  "ボスに Codex の再ログイン（codex の login をやり直す）を依頼してください（ChatGPT Plus の認証切れが原因）。";

// ===== 依頼（imagegen_job） =====

export interface ImagegenSize {
  readonly width: number;
  readonly height: number;
}

export interface ImagegenImageSpec {
  readonly id: string;
  readonly purpose: string;
  readonly prompt: string;
  /** 同一プロンプトからの枚数（既定 1）。2 以上は `<id>-1` `<id>-2` の連番。 */
  readonly count: number;
  /** 最終ピクセル。null は「リサイズしない」（`size: none` または未指定）。 */
  readonly size: ImagegenSize | null;
  /** contain=長辺合わせ（既定）／none=リサイズしない。cover（切り抜き）は様式として持たない。 */
  readonly fit: "contain" | "none";
  readonly format: "png" | "webp";
  /** 省略時は `<id>.<format>`（count>=2 なら連番 suffix が入る）。 */
  readonly filename: string | null;
}

export interface ImagegenJob {
  readonly jobId: string;
  readonly requester: string | null;
  /** imagegen の cwd からの相対パス。既定は tmp/images/<job_id>。 */
  readonly destRoot: string;
  readonly images: readonly ImagegenImageSpec[];
  /**
   * 再生成する id の絞り込み（ボス裁定 A1: ボス目視 NG の画像だけを作り直す経路）。
   * null なら images 全件。空配列は「対象なし」となるため様式として許さない。
   */
  readonly regenerate: readonly string[] | null;
  readonly notes: string | null;
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const IMAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SIZE_RE = /^(\d{1,5})x(\d{1,5})$/;

/** 検証エラーをまとめて投げる（1 個ずつ直させないため全件を並べる）。 */
export class ImagegenValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`imagegen 様式エラー:\n- ${issues.join("\n- ")}`);
    this.name = "ImagegenValidationError";
    this.issues = issues;
  }
}

/**
 * 依頼 YAML を検証して正規化する。1 個でも問題があれば ImagegenValidationError を投げる
 * （投げる前に全件を集める）。
 */
export function parseImagegenJob(text: string): ImagegenJob {
  const issues: string[] = [];
  const root = parseRootMap(text, "imagegen_job", IMAGEGEN_JOB_VERSION, issues);
  if (root === null) throw new ImagegenValidationError(issues);

  const jobId = requireString(root, "job_id", issues) ?? "";
  if (jobId !== "" && !JOB_ID_RE.test(jobId)) {
    issues.push(`job_id は英数と - のみ（保存先ディレクトリ名になる）: ${jobId}`);
  }
  const requester = optionalString(root, "requester", issues);
  const notes = optionalString(root, "notes", issues);
  const destRoot = optionalString(root, "dest_root", issues) ?? defaultDestRoot(jobId);
  if (destRoot.startsWith("/") || destRoot.split("/").includes("..")) {
    issues.push(`dest_root は cwd 配下の相対パスにすること（絶対パス・.. は不可）: ${destRoot}`);
  }

  const rawImages = root.get("images");
  const images: ImagegenImageSpec[] = [];
  if (!Array.isArray(rawImages)) {
    issues.push("images はリスト（- id: ... の並び）である必要があります");
  } else if (rawImages.length === 0) {
    issues.push("images が空です");
  } else {
    const seen = new Set<string>();
    rawImages.forEach((raw, i) => {
      // id の重複は「その要素に他の不備があっても」必ず指摘する（後で直す量が読めるように）。
      const rawId = raw instanceof Map && typeof raw.get("id") === "string" ? String(raw.get("id")).trim() : null;
      if (rawId !== null) {
        if (seen.has(rawId)) issues.push(`images[].id が重複しています: ${rawId}`);
        seen.add(rawId);
      }
      const spec = normalizeImageSpec(raw, i, issues);
      if (spec !== null) images.push(spec);
    });
  }

  const total = images.reduce((acc, s) => acc + s.count, 0);
  if (total > MAX_IMAGES_PER_JOB) {
    issues.push(
      `1 ジョブの上限は ${MAX_IMAGES_PER_JOB} 枚です（count の合計 = ${total}）。ジョブを分割してください`,
    );
  }

  const regenerate = normalizeRegenerate(root.get("regenerate"), images, issues);

  if (issues.length > 0) throw new ImagegenValidationError(issues);
  return { jobId, requester, destRoot, images, regenerate, notes };
}

function normalizeImageSpec(raw: unknown, index: number, issues: string[]): ImagegenImageSpec | null {
  const at = `images[${index}]`;
  if (!(raw instanceof Map)) {
    issues.push(`${at} はマップ（id/purpose/prompt を持つ）である必要があります`);
    return null;
  }
  const before = issues.length;
  const id = requireString(raw, "id", issues, at) ?? "";
  if (id !== "" && !IMAGE_ID_RE.test(id)) {
    issues.push(`${at}.id は英数と - のみ（ファイル名になる）: ${id}`);
  }
  const purpose = requireString(raw, "purpose", issues, at) ?? "";
  const prompt = requireString(raw, "prompt", issues, at) ?? "";

  const countRaw = optionalString(raw, "count", issues, at);
  let count = 1;
  if (countRaw !== null) {
    const n = Number(countRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_JOB) {
      issues.push(`${at}.count は 1〜${MAX_IMAGES_PER_JOB} の整数にすること: ${countRaw}`);
    } else {
      count = n;
    }
  }

  const sizeRaw = optionalString(raw, "size", issues, at);
  let size: ImagegenSize | null = null;
  if (sizeRaw !== null && sizeRaw !== "none") {
    const m = SIZE_RE.exec(sizeRaw);
    if (m === null) {
      issues.push(`${at}.size は WxH（例 512x512）か none にすること: ${sizeRaw}`);
    } else {
      size = { width: Number(m[1]), height: Number(m[2]) };
    }
  }

  const fitRaw = optionalString(raw, "fit", issues, at) ?? "contain";
  if (fitRaw !== "contain" && fitRaw !== "none") {
    // cover（切り抜き）は VC 方針で禁止。様式として受け付けない。
    issues.push(`${at}.fit は contain か none のみ（切り抜き cover は禁止）: ${fitRaw}`);
  }
  const fit = fitRaw === "none" ? "none" : "contain";

  const formatRaw = optionalString(raw, "format", issues, at) ?? "png";
  if (formatRaw !== "png" && formatRaw !== "webp") {
    issues.push(`${at}.format は png か webp のみ: ${formatRaw}`);
  }
  const format = formatRaw === "webp" ? "webp" : "png";

  const filename = optionalString(raw, "filename", issues, at);
  if (filename !== null && (filename.includes("/") || filename.startsWith("."))) {
    issues.push(`${at}.filename にディレクトリや先頭ドットは書けません: ${filename}`);
  }

  for (const key of raw.keys()) {
    if (!IMAGE_KEYS.has(key)) issues.push(`${at} に未知のキーがあります: ${key}`);
  }

  if (issues.length !== before) return null;
  return { id, purpose, prompt, count, size, fit, format, filename };
}

const IMAGE_KEYS = new Set(["id", "purpose", "prompt", "count", "size", "fit", "format", "filename"]);

function normalizeRegenerate(
  raw: unknown,
  images: readonly ImagegenImageSpec[],
  issues: string[],
): readonly string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    issues.push("regenerate はリスト（[a, b] か - a）である必要があります");
    return null;
  }
  if (raw.length === 0) {
    issues.push("regenerate が空です（全件生成なら regenerate ごと書かない）");
    return null;
  }
  const ids = raw.map((v) => String(v));
  const known = new Set(images.map((s) => s.id));
  for (const id of ids) {
    if (!known.has(id)) issues.push(`regenerate の id が images に存在しません: ${id}`);
  }
  return ids;
}

/**
 * 実際に生成する対象を返す（regenerate 指定があればその id だけ）。
 * ボス目視で NG だった画像を id 指定で作り直すとき、依頼 YAML はそのまま再投入すればよい。
 */
export function targetImages(job: ImagegenJob): readonly ImagegenImageSpec[] {
  if (job.regenerate === null) return job.images;
  const want = new Set(job.regenerate);
  return job.images.filter((s) => want.has(s.id));
}

/** 1 つの image spec が生む出力ファイル名（count>=2 は連番）。 */
export function outputFileNames(spec: ImagegenImageSpec): string[] {
  const ext = spec.format;
  if (spec.count === 1) return [spec.filename ?? `${spec.id}.${ext}`];
  const base = spec.filename ? stripExt(spec.filename) : spec.id;
  const suffix = spec.filename ? extOf(spec.filename) : ext;
  return Array.from({ length: spec.count }, (_, i) => `${base}-${i + 1}.${suffix}`);
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "png" : name.slice(i + 1);
}

// ===== 生成後の正規化（リサイズ／形式変換） =====

/**
 * 生成物 1 枚を配置・正規化・実測するシェルコマンド列（設計 §4.3 の実行可能版）。
 *
 * 許すのは **リサイズ（sips -Z の長辺合わせ）と形式変換（PNG→WebP）だけ**。
 * 減色・パレット化・トリム／切り抜き・背景除去・アルファ操作・回転・補正は一切生成しない
 * （VC 方針）。`sips -z H W`（縦横強制）は歪むので使わない。
 */
export function buildPostProcessCommands(
  generatedPath: string,
  destRoot: string,
  spec: ImagegenImageSpec,
  fileName: string,
): string[] {
  const target = `${destRoot}/${fileName}`;
  const png = spec.format === "webp" ? `${destRoot}/${stripExt(fileName)}.png` : target;
  const cmds: string[] = [`mkdir -p ${sh(destRoot)}`, `cp ${sh(generatedPath)} ${sh(png)}`];
  if (spec.size !== null && spec.fit === "contain") {
    // 長辺合わせ（アスペクト比を保つ）。指定と生成比が食い違っても切らない。
    cmds.push(`sips -Z ${Math.max(spec.size.width, spec.size.height)} ${sh(png)} >/dev/null`);
  }
  if (spec.format === "webp") {
    // sips は webp を読めるが書けない（本機実測）。cwebp が無ければ PNG のまま残す（TOOL_MISSING）。
    cmds.push(`cwebp -q 90 ${sh(png)} -o ${sh(target)} && rm ${sh(png)}`);
  }
  cmds.push(`sips -g pixelWidth -g pixelHeight ${sh(target)}`, `stat -f%z ${sh(target)}`);
  return cmds;
}

/** シェル用の単純クォート（' を含むパスも安全に通す）。 */
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ===== 報告（imagegen_result） =====

export interface ImagegenResultItem {
  readonly id: string;
  readonly status: ImagegenStatus;
  readonly path: string | null;
  readonly pixels: string | null;
  readonly bytes: number | null;
  readonly format: string | null;
  readonly tool: string | null;
  readonly errorCode: ImagegenErrorCode | null;
  readonly note: string | null;
}

export interface ImagegenResult {
  readonly jobId: string;
  readonly summary: string;
  readonly results: readonly ImagegenResultItem[];
  readonly genSeconds: number | null;
}

/** 報告 YAML を検証して正規化する（master が受け取った本文を機械照合するための口）。 */
export function parseImagegenResult(text: string): ImagegenResult {
  const issues: string[] = [];
  const root = parseRootMap(text, "imagegen_result", IMAGEGEN_RESULT_VERSION, issues);
  if (root === null) throw new ImagegenValidationError(issues);

  const jobId = requireString(root, "job_id", issues) ?? "";
  const summary = requireString(root, "summary", issues) ?? "";
  const genSecondsRaw = optionalString(root, "gen_seconds", issues);
  const genSeconds = genSecondsRaw === null ? null : Number(genSecondsRaw);
  if (genSecondsRaw !== null && !Number.isFinite(genSeconds)) {
    issues.push(`gen_seconds は数値にすること: ${genSecondsRaw}`);
  }

  const rawResults = root.get("results");
  const results: ImagegenResultItem[] = [];
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    issues.push("results はリスト（- id: ... の並び）で 1 件以上必要です");
  } else {
    rawResults.forEach((raw, i) => {
      const item = normalizeResultItem(raw, i, issues);
      if (item !== null) results.push(item);
    });
  }

  if (issues.length > 0) throw new ImagegenValidationError(issues);
  return { jobId, summary, results, genSeconds: genSeconds === null ? null : genSeconds };
}

function normalizeResultItem(raw: unknown, index: number, issues: string[]): ImagegenResultItem | null {
  const at = `results[${index}]`;
  if (!(raw instanceof Map)) {
    issues.push(`${at} はマップである必要があります`);
    return null;
  }
  const before = issues.length;
  const id = requireString(raw, "id", issues, at) ?? "";
  const statusRaw = requireString(raw, "status", issues, at) ?? "";
  if (statusRaw !== "" && !(IMAGEGEN_STATUSES as readonly string[]).includes(statusRaw)) {
    issues.push(`${at}.status は ${IMAGEGEN_STATUSES.join(" | ")} のいずれか: ${statusRaw}`);
  }
  const status = statusRaw as ImagegenStatus;

  const path = optionalString(raw, "path", issues, at);
  if (status === "ok" && (path === null || !path.startsWith("/"))) {
    // master が open_viewer にそのまま渡せるよう絶対パス固定。
    issues.push(`${at}.path は絶対パスで書くこと（status: ok では必須）`);
  }
  const pixels = optionalString(raw, "pixels", issues, at);
  if (status === "ok" && (pixels === null || !SIZE_RE.test(pixels))) {
    issues.push(`${at}.pixels は実測値を WxH で書くこと（status: ok では必須）`);
  }
  const bytesRaw = optionalString(raw, "bytes", issues, at);
  let bytes: number | null = null;
  if (bytesRaw !== null) {
    const n = Number(bytesRaw);
    if (!Number.isInteger(n) || n < 0) issues.push(`${at}.bytes は整数にすること: ${bytesRaw}`);
    else bytes = n;
  }
  const format = optionalString(raw, "format", issues, at);
  const tool = optionalString(raw, "tool", issues, at);

  const errorCodeRaw = optionalString(raw, "error_code", issues, at);
  let errorCode: ImagegenErrorCode | null = null;
  if (errorCodeRaw !== null) {
    if (!(IMAGEGEN_ERROR_CODES as readonly string[]).includes(errorCodeRaw)) {
      issues.push(`${at}.error_code は ${IMAGEGEN_ERROR_CODES.join(" | ")} のいずれか: ${errorCodeRaw}`);
    } else {
      errorCode = errorCodeRaw as ImagegenErrorCode;
    }
  }
  if (status !== "ok" && errorCode === null) {
    issues.push(`${at} は status が ok 以外なので error_code が必要です`);
  }
  const note = optionalString(raw, "note", issues, at);

  if (issues.length !== before) return null;
  return { id, status, path, pixels, bytes, format, tool, errorCode, note };
}

// ===== 最小 YAML パーサ（本様式が使う部分集合だけ） =====

type YamlNode = string | Map<string, YamlNode> | YamlNode[];

/** 先頭のバージョン行（`imagegen_job: v1`）を確かめてルートマップを返す。 */
function parseRootMap(
  text: string,
  versionKey: string,
  version: string,
  issues: string[],
): Map<string, YamlNode> | null {
  let root: YamlNode;
  try {
    root = parseSimpleYaml(text);
  } catch (err) {
    issues.push(`YAML を解釈できません: ${(err as Error).message}`);
    return null;
  }
  if (!(root instanceof Map)) {
    issues.push("トップレベルはマップ（key: value の並び）である必要があります");
    return null;
  }
  const v = root.get(versionKey);
  if (v === undefined) {
    issues.push(`先頭に ${versionKey}: ${version} が必要です`);
  } else if (v !== version) {
    issues.push(`${versionKey} は ${version} のみ対応です: ${String(v)}`);
  }
  return root;
}

function requireString(
  map: Map<string, YamlNode>,
  key: string,
  issues: string[],
  at = "",
): string | null {
  const prefix = at === "" ? "" : `${at}.`;
  const v = map.get(key);
  if (v === undefined) {
    issues.push(`${prefix}${key} は必須です`);
    return null;
  }
  if (typeof v !== "string" || v.trim() === "") {
    issues.push(`${prefix}${key} は空でない文字列である必要があります`);
    return null;
  }
  return v.trim();
}

function optionalString(
  map: Map<string, YamlNode>,
  key: string,
  issues: string[],
  at = "",
): string | null {
  const prefix = at === "" ? "" : `${at}.`;
  const v = map.get(key);
  if (v === undefined) return null;
  if (typeof v !== "string") {
    issues.push(`${prefix}${key} は文字列である必要があります`);
    return null;
  }
  const t = v.trim();
  return t === "" ? null : t;
}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

/**
 * YAML の部分集合パーサ。対応するのは:
 *   - ブロックマップ `key: value` / `key:`（子はインデント）
 *   - ブロックシーケンス `- value` / `- key: value`
 *   - ブロックスカラ `key: |`（末尾の改行は 1 個に畳む＝`|` 相当）
 *   - フローシーケンス `[a, b]`（文字列のみ）
 *   - 行コメント（`#` 始まり、または空白 + `#`。ブロックスカラ内では解釈しない）
 * アンカー・タグ・複数ドキュメント・フローマップ・複雑な引用は**対応しない**（Error を投げる）。
 */
export function parseSimpleYaml(text: string): YamlNode {
  const lines: Line[] = [];
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  raw.forEach((l, i) => {
    lines.push({ indent: l.length - l.trimStart().length, text: l, no: i + 1 });
  });
  const state = { i: 0, lines, raw };
  skipBlank(state);
  if (state.i >= lines.length) return new Map();
  const value = parseBlock(state, lines[state.i]!.indent);
  skipBlank(state);
  if (state.i < lines.length) {
    throw new Error(`${lines[state.i]!.no} 行目: インデントが揃っていません`);
  }
  return value;
}

interface ParseState {
  i: number;
  readonly lines: Line[];
  readonly raw: string[];
}

function skipBlank(s: ParseState): void {
  while (s.i < s.lines.length) {
    const t = s.lines[s.i]!.text.trim();
    if (t === "" || t.startsWith("#")) s.i++;
    else break;
  }
}

/** minIndent 以上のインデントで始まるブロック（マップかシーケンス）を読む。 */
function parseBlock(s: ParseState, minIndent: number): YamlNode {
  skipBlank(s);
  const line = s.lines[s.i];
  if (line === undefined || line.indent < minIndent) return "";
  // 実際のインデントは「minIndent 以上の最初の行」が決める（2 スペース／4 スペースの両方を許す）。
  const indent = line.indent;
  return line.text.trimStart().startsWith("- ") || line.text.trim() === "-"
    ? parseSequence(s, indent)
    : parseMap(s, indent);
}

function parseSequence(s: ParseState, indent: number): YamlNode[] {
  const out: YamlNode[] = [];
  for (;;) {
    skipBlank(s);
    const line = s.lines[s.i];
    if (line === undefined || line.indent !== indent) break;
    const body = line.text.trimStart();
    if (!body.startsWith("- ") && body !== "-") break;
    const rest = body === "-" ? "" : body.slice(2);
    if (rest.trim() === "") {
      s.i++;
      out.push(parseBlock(s, indent + 1));
      continue;
    }
    if (isKeyLine(rest)) {
      // `- key: value` は「その位置から始まるマップ」。以降の同インデント継続行も同じマップ。
      const childIndent = indent + 2;
      s.lines[s.i] = { indent: childIndent, text: " ".repeat(childIndent) + rest, no: line.no };
      out.push(parseMap(s, childIndent));
      continue;
    }
    s.i++;
    out.push(scalar(rest));
  }
  return out;
}

function parseMap(s: ParseState, indent: number): Map<string, YamlNode> {
  const map = new Map<string, YamlNode>();
  for (;;) {
    skipBlank(s);
    const line = s.lines[s.i];
    if (line === undefined || line.indent !== indent) break;
    const body = line.text.trimStart();
    if (body.startsWith("- ")) break;
    const idx = keyEnd(body);
    if (idx < 0) throw new Error(`${line.no} 行目: "key: value" の形ではありません: ${body}`);
    const key = body.slice(0, idx).trim();
    const rest = body.slice(idx + 1).trim();
    s.i++;
    if (rest === "|" || rest === "|-" || rest === ">") {
      map.set(key, readBlockScalar(s, indent, rest));
    } else if (rest === "") {
      map.set(key, parseBlock(s, indent + 1));
    } else if (rest.startsWith("[")) {
      map.set(key, parseFlowSequence(rest, line.no));
    } else {
      map.set(key, scalar(rest));
    }
  }
  return map;
}

/** ブロックスカラ（`|`）を読む。親より深いインデントの行を、共通インデントを剥いで連結する。 */
function readBlockScalar(s: ParseState, parentIndent: number, style: string): string {
  const body: string[] = [];
  let baseIndent = -1;
  for (;;) {
    const line = s.lines[s.i];
    if (line === undefined) break;
    if (line.text.trim() === "") {
      // 空行はブロック内でも継続しうる。次に深い行が来るなら本文の一部として保持する。
      body.push("");
      s.i++;
      continue;
    }
    if (line.indent <= parentIndent) break;
    if (baseIndent < 0) baseIndent = line.indent;
    body.push(line.text.slice(Math.min(baseIndent, line.indent)));
    s.i++;
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  const joined = style === ">" ? body.join(" ") : body.join("\n");
  return style === "|-" ? joined : joined + "\n";
}

function parseFlowSequence(text: string, lineNo: number): YamlNode[] {
  const trimmed = text.trim();
  if (!trimmed.endsWith("]")) throw new Error(`${lineNo} 行目: フローシーケンスが閉じていません`);
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => scalar(s.trim()));
}

/** `key: value` の `:` 位置（引用符内・URL の `://` を避ける最小限の判定）。 */
function keyEnd(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== ":") continue;
    const next = body[i + 1];
    if (next === undefined || next === " ") return i;
  }
  return -1;
}

function isKeyLine(body: string): boolean {
  return keyEnd(body) > 0;
}

/** 素のスカラ。行コメントを落とし、引用符を剥ぐ。 */
function scalar(text: string): string {
  let t = text;
  const hash = t.search(/\s#/);
  if (hash >= 0) t = t.slice(0, hash);
  t = t.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1);
  }
  return t;
}
