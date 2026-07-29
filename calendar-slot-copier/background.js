// 拡張アイコンのクリックで content script にトグルを通知しつつ、
// content script からの依頼で Google Calendar API に予定を作成する。
//
// chrome.identity は content script からは呼べないため、OAuth 認証と
// Calendar API 呼び出しはすべてこの service worker 側で行い、content script とは
// メッセージでやり取りする。

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CLIENT_ID_KEY = "csc_client_id";

// implicit フローで取得したアクセストークンのメモリキャッシュ（refresh_token は持たない）。
let cachedToken = null; // { token, expiresAt }

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "CSC_GET_CONFIG") {
    getConfig()
      .then((config) => sendResponse({ ok: true, ...config }))
      .catch((error) => sendResponse({ ok: false, message: errorMessage(error) }));
    return true;
  }

  if (message.type === "CSC_CREATE_EVENTS") {
    createEvents(message.events || [], message.title, message.timeZone)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, code: error && error.code, message: errorMessage(error) })
      );
    return true;
  }

  return undefined;
});

async function getConfig() {
  const stored = await chrome.storage.local.get(CLIENT_ID_KEY);
  return {
    clientId: stored[CLIENT_ID_KEY] || "",
    redirectUri: chrome.identity.getRedirectURL(),
  };
}

async function createEvents(events, title, timeZone) {
  if (!Array.isArray(events) || !events.length) {
    return { created: 0, failed: 0, links: [] };
  }

  const zone = timeZone || "Asia/Tokyo";
  const summary = (title && String(title).trim()) || "予定";

  let token = await acquireToken();
  const links = [];
  let failed = 0;
  let retriedAuth = false;

  for (const event of events) {
    let response = await insertEvent(token, event, summary, zone);

    // トークン失効(401)なら一度だけ対話認証で取り直して再試行する。
    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      cachedToken = null;
      token = await getToken(true);
      response = await insertEvent(token, event, summary, zone);
    }

    if (response.ok) {
      links.push(response.link || "");
    } else {
      failed += 1;
    }
  }

  return { created: links.length, failed, links };
}

async function insertEvent(token, event, summary, timeZone) {
  const body = {
    summary,
    start: { dateTime: event.start, timeZone },
    end: { dateTime: event.end, timeZone },
  };

  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (response.ok) {
    const json = await response.json().catch(() => ({}));
    return { ok: true, status: response.status, link: json.htmlLink || "" };
  }
  return { ok: false, status: response.status };
}

// まず無操作(silent)で取得を試み、同意が必要な場合のみ対話認証にフォールバックする。
async function acquireToken() {
  try {
    return await getToken(false);
  } catch (error) {
    if (error && error.code === "NO_CLIENT_ID") throw error;
    return await getToken(true);
  }
}

async function getToken(interactive) {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) {
    return cachedToken.token;
  }

  const stored = await chrome.storage.local.get(CLIENT_ID_KEY);
  const clientId = stored[CLIENT_ID_KEY];
  if (!clientId) {
    throw makeError("Google の OAuth クライアントIDが未設定です。", "NO_CLIENT_ID");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: CAL_SCOPE,
  });
  if (!interactive) params.set("prompt", "none");

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString(),
      interactive,
    });
  } catch (error) {
    throw makeError("Google 認証に失敗しました。" + errorMessage(error), "AUTH_FAILED");
  }

  const fragment = (redirectUrl && redirectUrl.split("#")[1]) || "";
  const result = new URLSearchParams(fragment);
  const token = result.get("access_token");
  if (!token) {
    throw makeError("アクセストークンを取得できませんでした。", "AUTH_FAILED");
  }

  const expiresIn = Number(result.get("expires_in") || "3600");
  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorMessage(error) {
  if (!error) return "";
  return error.message ? error.message : String(error);
}
