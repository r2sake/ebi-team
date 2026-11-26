// 開きっぱなしのタブが古い画面（古い JS / CSS）のまま残るのを知らせる。
//
// ebi-team の画面は WebSocket でつながったまま何日も開かれ続ける。画面の側だけビルドし直して
// dist/client を入れ替えても、開いているタブは読み込んだ時点の JS / CSS を使い続けるため、
// 直しがボスの画面に届かない（2026-11: 書体の直し #29 を配ったのに、古いタブで化けが続いた）。
// そこで、配っている index.html の入口（/assets/index-<hash>.js・.css）を時々取り直し、
// 今のタブが読んだ入口と違えば「新しい画面があります」の帯を出して、再読み込みを促す。
// 勝手に再読み込みはしない（チャットの書きかけ等を消さないため）。

/** index.html の文字列から、入口の資産（/assets/ 配下の script src・stylesheet href）を取り出す。純関数。 */
export function extractEntryAssets(html: string): string[] {
  const out = new Set<string>();
  const re = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    // /assets/ 配下（Vite のビルド成果物・ハッシュ付き）だけを見る。dev（/main.ts 等）は対象外。
    const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/^\.\//, "/");
    if (/^\/assets\/.+\.(?:js|css)$/.test(path)) out.add(path);
  }
  return [...out].sort();
}

/** 今のタブと配っている版の入口の組を比べ、配っている側が別の版なら true。どちらかが空なら判定しない。 */
export function isStaleBuild(current: string[], served: string[]): boolean {
  if (current.length === 0 || served.length === 0) return false;
  if (current.length !== served.length) return true;
  return current.some((v, i) => v !== served[i]);
}

/** 今のタブが読み込んだ入口（DOM の script / link から）。 */
function currentEntryAssets(): string[] {
  const html = [...document.querySelectorAll("script[src], link[href]")]
    .map((el) => el.outerHTML)
    .join("\n");
  return extractEntryAssets(html);
}

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 古いタブの見張りを始める。返り値の関数を呼ぶと、その場で 1 回確かめる（WS の再接続時など）。
 * 新しい版を見つけたら帯を 1 回だけ出す。
 */
export function startBuildCheck(): () => void {
  const current = currentEntryAssets();
  let shown = false;
  let inflight = false;

  const check = async (): Promise<void> => {
    if (shown || inflight || current.length === 0) return;
    inflight = true;
    try {
      const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return;
      const served = extractEntryAssets(await res.text());
      if (isStaleBuild(current, served)) {
        shown = true;
        showBanner();
      }
    } catch {
      // サーバ再起動中などは黙って次の機会に回す。
    } finally {
      inflight = false;
    }
  };

  window.setInterval(() => void check(), CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  return () => void check();
}

function showBanner(): void {
  const bar = document.createElement("div");
  bar.className = "build-stale-bar";
  bar.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = "画面の新しい版が出ています。再読み込みすると反映されます。";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "再読み込み";
  btn.addEventListener("click", () => location.reload());
  const close = document.createElement("button");
  close.type = "button";
  close.className = "build-stale-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "閉じる");
  close.addEventListener("click", () => bar.remove());
  bar.append(text, btn, close);
  document.body.append(bar);
}
