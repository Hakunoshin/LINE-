// 成約報酬くらべ Web UI (Workerが配信する単一ページ)。
// 企業名を入力すると /api/compare を叩いて circus/peterpan/trueaim の比較結果を表示する。
// クライアント側JSはテンプレートリテラルを使わず文字列連結で書いている
// (このファイル自体がテンプレートリテラルのため)。

export const PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>成約報酬くらべ</title>
<style>
  :root {
    --bg: #f5f6f8; --panel: #ffffff; --ink: #1a1d21; --sub: #6b7280;
    --line: #e5e7eb; --brand: #2f6df6; --brand-ink: #ffffff;
    --gold: #eab308; --chip: #eef2ff; --chip-ink: #3752a8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --panel: #171a20; --ink: #f2f4f7; --sub: #9aa4b2;
      --line: #262b33; --brand: #4f86ff; --brand-ink: #0b1220;
      --gold: #f5c542; --chip: #1c2436; --chip-ink: #a9c0ff;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif;
    display: flex; flex-direction: column; height: 100dvh;
  }
  header {
    padding: 14px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 10px; flex: none;
  }
  header .logo { font-size: 20px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 700; }
  header .sub { font-size: 12px; color: var(--sub); margin-left: auto; }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .row { display: flex; }
  .row.me { justify-content: flex-end; }
  .bubble {
    max-width: min(680px, 92%); padding: 12px 14px; border-radius: 14px; line-height: 1.6;
    font-size: 14px; white-space: pre-wrap; word-break: break-word;
  }
  .me .bubble { background: var(--brand); color: var(--brand-ink); border-bottom-right-radius: 4px; }
  .bot .bubble { background: var(--panel); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
  .card h2 { font-size: 15px; margin: 0 0 2px; }
  .card .meta { font-size: 12px; color: var(--sub); margin-bottom: 10px; }
  .rank { display: flex; align-items: baseline; gap: 8px; padding: 8px 0; border-top: 1px dashed var(--line); }
  .rank:first-of-type { border-top: none; }
  .rank .no { width: 18px; color: var(--sub); font-variant-numeric: tabular-nums; }
  .rank .pf { font-weight: 700; width: 78px; }
  .rank .amt { font-weight: 800; font-variant-numeric: tabular-nums; }
  .rank .note { font-size: 12px; color: var(--sub); margin-left: auto; text-align: right; }
  .rank.top { background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--gold) 16%, transparent)); border-radius: 8px; padding-left: 8px; }
  .rank.na .pf, .rank.na .amt { color: var(--sub); font-weight: 600; }
  .winner { margin-top: 10px; font-weight: 700; }
  .winner .crown { color: var(--gold); }
  .raw { font-size: 11px; color: var(--sub); margin-top: 2px; }
  form {
    flex: none; display: flex; gap: 8px; padding: 12px; background: var(--panel);
    border-top: 1px solid var(--line); align-items: center; padding-bottom: calc(12px + env(safe-area-inset-bottom));
  }
  input {
    font: inherit; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px;
    background: var(--bg); color: var(--ink); outline: none;
  }
  input:focus { border-color: var(--brand); }
  #company { flex: 1; min-width: 0; }
  #theory { width: 128px; }
  button {
    font: inherit; font-weight: 700; padding: 12px 18px; border: none; border-radius: 12px;
    background: var(--brand); color: var(--brand-ink); cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: default; }
  .hint { font-size: 11px; color: var(--sub); padding: 0 14px 8px; }
  .dots span { animation: blink 1.2s infinite both; }
  .dots span:nth-child(2){ animation-delay:.2s } .dots span:nth-child(3){ animation-delay:.4s }
  @keyframes blink { 0%,80%,100%{opacity:.2} 40%{opacity:1} }
</style>
</head>
<body>
  <header>
    <span class="logo">💰</span>
    <h1>成約報酬くらべ</h1>
    <span class="sub">circus / peterpan / trueaim</span>
  </header>
  <div id="log">
    <div class="row bot"><div class="bubble">企業名を入力すると、peterpan・trueaim・circus の成約報酬を比較して一番高い媒体を表示します。
料率型（理論年収×◯%）を金額換算するときは「理論年収(万円)」も入れてください。</div></div>
  </div>
  <div class="hint">例：株式会社レオパレス21 ／ 理論年収 500（万円・任意）</div>
  <form id="f">
    <input id="company" type="text" placeholder="企業名（フルネーム）" autocomplete="off" enterkeyhint="search" />
    <input id="theory" type="number" inputmode="numeric" placeholder="理論年収 万" />
    <button id="send" type="submit">比較</button>
  </form>
<script>
(function(){
  var log = document.getElementById("log");
  var form = document.getElementById("f");
  var companyEl = document.getElementById("company");
  var theoryEl = document.getElementById("theory");
  var sendBtn = document.getElementById("send");

  function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }
  function scroll(){ log.scrollTop = log.scrollHeight; }

  function addRow(who, html){
    var row = document.createElement("div");
    row.className = "row " + who;
    var b = document.createElement("div");
    b.className = "bubble";
    b.innerHTML = html;
    row.appendChild(b);
    log.appendChild(row);
    scroll();
    return b;
  }

  function yen(v){ return v == null ? "—" : (v + "万円"); }

  function renderResult(r){
    var h = '<div class="card">';
    h += '<h2>' + esc(r.query) + '</h2>';
    var t = (r.theoryIncomeMan != null)
      ? ("理論年収 " + r.theoryIncomeMan + "万円 (" + esc(r.theorySource || "") + ")")
      : "理論年収 未設定（料率型は金額換算できません）";
    h += '<div class="meta">' + t + '</div>';

    var found = r.results.filter(function(x){ return x.company != null; });
    if (found.length === 0){
      h += '<div>いずれの媒体にも該当求人が見つかりませんでした。企業名をフルネームで入れてみてください。</div></div>';
      return h;
    }
    var rank = 1;
    var topPlatform = null, topYen = null;
    for (var i=0;i<r.results.length;i++){
      var x = r.results[i];
      if (x.company == null){
        h += '<div class="rank na"><span class="no"></span><span class="pf">' + esc(x.platform) + '</span><span class="amt">該当なし</span></div>';
        continue;
      }
      var isTop = (x.bestYenMan != null && topYen == null);
      if (isTop){ topYen = x.bestYenMan; topPlatform = x.platform; }
      h += '<div class="rank' + (isTop ? ' top' : '') + '">'
         + '<span class="no">' + rank + '</span>'
         + '<span class="pf">' + esc(x.platform) + '</span>'
         + '<span class="amt">' + yen(x.bestYenMan) + '</span>'
         + '<span class="note">' + esc(x.note) + '</span>'
         + '</div>';
      if (x.rewardRaw){
        h += '<div class="raw">└ ' + esc(String(x.rewardRaw).replace(/\\s*\\n\\s*/g, " / ")) + '</div>';
      }
      rank++;
    }
    if (topPlatform != null){
      h += '<div class="winner"><span class="crown">👑</span> 一番高いのは ' + esc(topPlatform) + '（' + topYen + '万円）</div>';
    } else if (r.theoryIncomeMan == null){
      h += '<div class="winner">※ 料率型のみです。理論年収を入れると金額で比較できます。</div>';
    }
    h += '</div>';
    return h;
  }

  form.addEventListener("submit", async function(e){
    e.preventDefault();
    var company = companyEl.value.trim();
    if (!company) return;
    var theory = theoryEl.value.trim();
    var label = esc(company) + (theory ? ('　<small>理論年収 ' + esc(theory) + '万</small>') : '');
    addRow("me", label);
    companyEl.value = "";
    sendBtn.disabled = true;
    var loading = addRow("bot", '<span class="dots"><span>●</span><span>●</span><span>●</span></span>');
    try {
      var url = "/api/compare?company=" + encodeURIComponent(company) + (theory ? ("&theory=" + encodeURIComponent(theory)) : "");
      var res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      loading.innerHTML = renderResult(data);
    } catch (err) {
      loading.innerHTML = "エラー: " + esc(err && err.message ? err.message : String(err));
    } finally {
      sendBtn.disabled = false;
      companyEl.focus();
      scroll();
    }
  });
})();
</script>
</body>
</html>`;
