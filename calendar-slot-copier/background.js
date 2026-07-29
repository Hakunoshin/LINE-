chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "CSC_TOGGLE" }).catch((err) => {
    // content scriptにメッセージが届かなかった（未注入・ページ未対応など）→ 画面に直接理由を表示する
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        func: (message) => {
          const box = document.createElement("div");
          box.style.cssText =
            "position:fixed;top:16px;left:16px;right:16px;z-index:2147483647;" +
            "background:#fce8e6;color:#8f1d11;border:2px solid #d93025;border-radius:8px;" +
            "padding:12px 16px;font:13px/1.5 monospace;white-space:pre-wrap;";
          box.textContent =
            "[候補日コピー] content scriptにメッセージが届きませんでした。\n" +
            "考えられる原因: このタブがcalendar.google.com読み込み後に拡張機能を有効化した／このページがまだ読み込み中。\n" +
            "→ このタブを一度リロードしてから、もう一度アイコンをクリックしてください。\n\n" +
            "詳細: " + message;
          document.body.appendChild(box);
        },
        args: [String(err && err.message ? err.message : err)],
      })
      .catch(() => {
        // このページ自体にスクリプトを注入できない（chrome://等）場合は諦める
      });
  });
});
