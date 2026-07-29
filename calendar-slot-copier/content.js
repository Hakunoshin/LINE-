(() => {
  "use strict";

  const INSTANCE_KEY = "__calendarSlotCopierInstance";
  const WEEKDAY_KANJI = ["日", "月", "火", "水", "木", "金", "土"];
  const SNAP_MINUTES = 15;
  const DAY_MINUTES = 24 * 60;

  const previous = window[INSTANCE_KEY];
  if (previous && typeof previous.dispose === "function") {
    previous.dispose();
  }

  let panelEl = null;
  let overlayEl = null;
  let listEl = null;
  let labelInputEl = null;
  let copyBtnEl = null;
  let addToCalBtnEl = null;
  let warningEl = null;
  let debugEl = null;
  let debugPreEl = null;
  let settingsBodyEl = null;
  let clientIdInputEl = null;
  let redirectUriEl = null;
  let settingsStatusEl = null;

  let selections = [];
  let layout = null;
  let drawing = null;
  let uiAbort = null;
  let drawingAbort = null;
  let layoutTimer = null;
  let pollTimer = null;
  let panelDragAbort = null;

  const messageListener = (message) => {
    if (!message || message.type !== "CSC_TOGGLE") return;
    try {
      toggle();
    } catch (error) {
      showFatalError(error);
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
  window[INSTANCE_KEY] = { toggle, dispose };

  function toggle() {
    if (panelEl) {
      teardown();
    } else {
      init();
    }
  }

  function init() {
    uiAbort = new AbortController();
    buildPanel();
    buildOverlay();

    const options = { capture: true, signal: uiAbort.signal };
    window.addEventListener("resize", scheduleLayout, options);
    window.addEventListener("popstate", scheduleLayout, options);
    window.addEventListener("hashchange", scheduleLayout, options);
    document.addEventListener("scroll", scheduleLayout, options);
    document.addEventListener("keydown", onKeyDown, options);

    pollTimer = window.setInterval(() => {
      if (!drawing) recomputeLayout();
    }, 1000);

    recomputeLayout();
  }

  function teardown() {
    cancelDrawing();
    if (layoutTimer) window.clearTimeout(layoutTimer);
    if (pollTimer) window.clearInterval(pollTimer);
    if (panelDragAbort) panelDragAbort.abort();
    if (uiAbort) uiAbort.abort();

    layoutTimer = null;
    pollTimer = null;
    panelDragAbort = null;
    uiAbort = null;
    layout = null;
    selections = [];

    if (panelEl) panelEl.remove();
    if (overlayEl) overlayEl.remove();

    panelEl = null;
    overlayEl = null;
    listEl = null;
    labelInputEl = null;
    copyBtnEl = null;
    addToCalBtnEl = null;
    warningEl = null;
    debugEl = null;
    debugPreEl = null;
    settingsBodyEl = null;
    clientIdInputEl = null;
    redirectUriEl = null;
    settingsStatusEl = null;
  }

  function dispose() {
    teardown();
    chrome.runtime.onMessage.removeListener(messageListener);
    if (window[INSTANCE_KEY] && window[INSTANCE_KEY].dispose === dispose) {
      delete window[INSTANCE_KEY];
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") teardown();
  }

  function scheduleLayout() {
    if (!panelEl) return;
    if (drawing) {
      cancelDrawing("画面の表示が変わったため、選択を中止しました。");
    }
    if (layoutTimer) window.clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(() => {
      layoutTimer = null;
      recomputeLayout();
    }, 120);
  }

  function buildPanel() {
    panelEl = document.createElement("section");
    panelEl.className = "csc-panel";
    panelEl.setAttribute("aria-label", "候補日コピー");
    panelEl.innerHTML =
      '<div class="csc-panel-header">📅 候補日コピー</div>' +
      '<div class="csc-panel-hint">時間グリッドをドラッグして追加 / 緑の選択をクリックして削除</div>' +
      '<div class="csc-warning" style="display:none"></div>' +
      '<div class="csc-debug" style="display:none">' +
      '<button type="button" class="csc-btn csc-btn-secondary csc-debug-copy">検出結果をコピー</button>' +
      '<pre class="csc-debug-pre"></pre>' +
      "</div>" +
      '<div class="csc-panel-body">' +
      '<input class="csc-label-input" aria-label="コピー時の見出し / 予定タイトル" value="【候補日】" />' +
      '<ul class="csc-list"></ul>' +
      "</div>" +
      '<div class="csc-settings">' +
      '<button type="button" class="csc-settings-toggle">⚙ Google連携設定</button>' +
      '<div class="csc-settings-body" style="display:none">' +
      '<p class="csc-settings-note">「カレンダーに登録」で予定を自動作成するには、Google の OAuth クライアントID（ウェブアプリケーション）が必要です。未設定の場合は予定作成画面を開く方式で代用します。</p>' +
      '<label class="csc-settings-label">承認済みのリダイレクトURI（この値をOAuthクライアントに登録）</label>' +
      '<code class="csc-redirect-uri">読み込み中…</code>' +
      '<label class="csc-settings-label">OAuth クライアントID</label>' +
      '<input class="csc-client-id" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off" spellcheck="false" />' +
      '<button type="button" class="csc-btn csc-btn-secondary csc-save-client">保存</button>' +
      '<span class="csc-settings-status"></span>' +
      "</div>" +
      "</div>" +
      '<div class="csc-panel-footer">' +
      '<button type="button" class="csc-btn csc-btn-secondary" data-action="close">終了</button>' +
      '<button type="button" class="csc-btn csc-btn-calendar" data-action="calendar">カレンダーに登録</button>' +
      '<button type="button" class="csc-btn csc-btn-primary" data-action="copy">コピーする</button>' +
      "</div>";

    document.body.appendChild(panelEl);
    listEl = panelEl.querySelector(".csc-list");
    labelInputEl = panelEl.querySelector(".csc-label-input");
    copyBtnEl = panelEl.querySelector('[data-action="copy"]');
    addToCalBtnEl = panelEl.querySelector('[data-action="calendar"]');
    warningEl = panelEl.querySelector(".csc-warning");
    debugEl = panelEl.querySelector(".csc-debug");
    debugPreEl = panelEl.querySelector(".csc-debug-pre");

    panelEl.querySelector('[data-action="close"]').addEventListener("click", teardown, {
      signal: uiAbort.signal,
    });
    copyBtnEl.addEventListener("click", onCopy, { signal: uiAbort.signal });
    addToCalBtnEl.addEventListener("click", onAddAllToCalendar, { signal: uiAbort.signal });

    settingsBodyEl = panelEl.querySelector(".csc-settings-body");
    clientIdInputEl = panelEl.querySelector(".csc-client-id");
    redirectUriEl = panelEl.querySelector(".csc-redirect-uri");
    settingsStatusEl = panelEl.querySelector(".csc-settings-status");

    panelEl.querySelector(".csc-settings-toggle").addEventListener(
      "click",
      () => {
        const open = settingsBodyEl.style.display !== "none";
        settingsBodyEl.style.display = open ? "none" : "block";
      },
      { signal: uiAbort.signal }
    );
    panelEl.querySelector(".csc-save-client").addEventListener("click", onSaveClientId, {
      signal: uiAbort.signal,
    });
    loadConfig();

    panelEl.querySelector(".csc-debug-copy").addEventListener(
      "click",
      async () => {
        try {
          await copyText(debugPreEl.textContent || "");
          flashCopyResult("検出結果をコピーしました", true);
        } catch (error) {
          flashCopyResult("コピーに失敗しました", false);
        }
      },
      { signal: uiAbort.signal }
    );

    makePanelDraggable(panelEl, panelEl.querySelector(".csc-panel-header"));
  }

  function makePanelDraggable(panel, handle) {
    handle.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 0) return;
        if (panelDragAbort) panelDragAbort.abort();
        panelDragAbort = new AbortController();

        const startX = event.clientX;
        const startY = event.clientY;
        const rect = panel.getBoundingClientRect();
        const startRight = window.innerWidth - rect.right;
        const startTop = rect.top;

        window.addEventListener(
          "mousemove",
          (moveEvent) => {
            panel.style.right = String(startRight - (moveEvent.clientX - startX)) + "px";
            panel.style.top = String(Math.max(0, startTop + (moveEvent.clientY - startY))) + "px";
          },
          { signal: panelDragAbort.signal }
        );
        window.addEventListener(
          "mouseup",
          () => {
            if (panelDragAbort) panelDragAbort.abort();
            panelDragAbort = null;
          },
          { once: true, signal: panelDragAbort.signal }
        );
        event.preventDefault();
      },
      { signal: uiAbort.signal }
    );
  }

  function buildOverlay() {
    overlayEl = document.createElement("div");
    overlayEl.className = "csc-overlay";
    document.body.appendChild(overlayEl);
  }

  function recomputeLayout() {
    if (!panelEl || !overlayEl) return;
    const nextLayout = calculateLayout();

    if (!nextLayout.valid) {
      layout = null;
      showWarning(nextLayout.reason);
      showDebug(nextLayout.debugLines || []);
    } else {
      layout = nextLayout;
      showWarning("");
      clearDebug();
    }
    render();
  }

  function calculateLayout() {
    const main = document.querySelector('[role="main"]');
    if (!main) return invalidLayout("Google カレンダーの表示領域を検出できませんでした。");

    const anchorDate = readAnchorDate(main);
    if (!anchorDate) {
      return invalidLayout("表示中の日付を検出できませんでした。週表示または日表示にしてください。");
    }

    const headerCandidates = Array.from(main.querySelectorAll('[role="columnheader"]'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalizeText(element.textContent || "");
        const dayMatch = text.match(/(\d{1,2})$/);
        return {
          element,
          rect,
          text,
          day: dayMatch ? Number(dayMatch[1]) : null,
          weekdayMatch: text.match(/[日月火水木金土]/),
        };
      })
      .filter((item) => item.day && item.rect.width > 40 && item.rect.height > 16)
      .filter((item) => item.rect.bottom > 0 && item.rect.left < window.innerWidth)
      .sort((a, b) => a.rect.left - b.rect.left);

    const headers = distinctColumns(headerCandidates);
    if (headers.length < 1 || headers.length > 7) {
      return invalidLayout("日付列を検出できませんでした。週表示または日表示にしてください。", [
        "日付ヘッダー候補: " + String(headers.length) + "件",
      ]);
    }

    const gridCells = Array.from(main.querySelectorAll('[role="gridcell"]'))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 40 && item.rect.height > 360)
      .filter((item) => item.rect.right > 0 && item.rect.left < window.innerWidth);

    if (gridCells.length < headers.length) {
      return invalidLayout("時間グリッドを検出できませんでした。週表示または日表示にしてください。", [
        "日付ヘッダー: " + String(headers.length) + "件",
        "時間グリッド候補: " + String(gridCells.length) + "件",
      ]);
    }

    const headerBottom = Math.max(...headers.map((header) => header.rect.bottom));
    const columns = [];

    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      const headerCenter = (header.rect.left + header.rect.right) / 2;
      const matchingCells = gridCells
        .map((cell) => ({
          cell,
          distance: Math.abs((cell.rect.left + cell.rect.right) / 2 - headerCenter),
        }))
        .filter((item) => item.distance < Math.max(header.rect.width, 64) * 0.55)
        .sort((a, b) => a.distance - b.distance);

      if (!matchingCells.length) {
        return invalidLayout("日付列と時間グリッドの対応を確認できませんでした。");
      }

      const grid = matchingCells[0].cell;
      const date = addDays(anchorDate, index);
      if (date.getDate() !== header.day) {
        return invalidLayout("日付ヘッダーの並びを確認できませんでした。", [
          "先頭日付: " + formatDateKey(anchorDate),
          "列 " + String(index + 1) + ": ヘッダー " + String(header.day) + "日",
        ]);
      }
      if (
        header.weekdayMatch &&
        header.weekdayMatch[0] !== WEEKDAY_KANJI[date.getDay()]
      ) {
        return invalidLayout("曜日ヘッダーの並びを確認できませんでした。");
      }

      const clipped = clippedRect(grid.element, grid.rect);
      const visibleTop = Math.max(clipped.top, headerBottom);
      const visibleBottom = Math.min(clipped.bottom, window.innerHeight);
      if (visibleBottom - visibleTop < 8) {
        return invalidLayout("時間グリッドの表示範囲を確認できませんでした。");
      }
      if (grid.rect.height / 24 < 12 || grid.rect.height / 24 > 120) {
        return invalidLayout("時間グリッドの時間幅を確認できませんでした。");
      }

      columns.push({
        dateKey: formatDateKey(date),
        left: grid.rect.left,
        right: grid.rect.right,
        gridTop: grid.rect.top,
        gridHeight: grid.rect.height,
        visibleTop,
        visibleBottom,
      });
    }

    const reference = columns[0];
    const consistent = columns.every(
      (column) =>
        Math.abs(column.gridTop - reference.gridTop) < 3 &&
        Math.abs(column.gridHeight - reference.gridHeight) < 3
    );
    if (!consistent) {
      return invalidLayout("時間グリッドの列位置を確認できませんでした。");
    }

    return {
      valid: true,
      columns,
      debugLines: columns.map(
        (column) =>
          column.dateKey +
          " x=" +
          Math.round(column.left) +
          "-" +
          Math.round(column.right) +
          " y=" +
          Math.round(column.visibleTop) +
          "-" +
          Math.round(column.visibleBottom)
      ),
    };
  }

  function invalidLayout(reason, debugLines) {
    return { valid: false, reason, debugLines: debugLines || [] };
  }

  function readAnchorDate(main) {
    const sources = Array.from(main.querySelectorAll("h1"))
      .map((element) => normalizeText(element.textContent || ""))
      .concat(normalizeText(document.title || ""));

    for (const source of sources) {
      const match = source.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
      if (!match) continue;
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (
        date.getFullYear() === Number(match[1]) &&
        date.getMonth() === Number(match[2]) - 1 &&
        date.getDate() === Number(match[3])
      ) {
        return date;
      }
    }
    return null;
  }

  function distinctColumns(candidates) {
    const columns = [];
    for (const candidate of candidates) {
      const center = (candidate.rect.left + candidate.rect.right) / 2;
      const existing = columns.find(
        (item) => Math.abs((item.rect.left + item.rect.right) / 2 - center) < 4
      );
      if (!existing || candidate.rect.width > existing.rect.width) {
        if (existing) columns.splice(columns.indexOf(existing), 1);
        columns.push(candidate);
      }
    }
    return columns.sort((a, b) => a.rect.left - b.rect.left);
  }

  function clippedRect(element, initialRect) {
    const bounds = {
      left: Math.max(0, initialRect.left),
      right: Math.min(window.innerWidth, initialRect.right),
      top: Math.max(0, initialRect.top),
      bottom: Math.min(window.innerHeight, initialRect.bottom),
    };

    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const clips =
        /(auto|scroll|hidden|clip)/.test(style.overflowX) ||
        /(auto|scroll|hidden|clip)/.test(style.overflowY);
      if (!clips) continue;

      const rect = parent.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      bounds.left = Math.max(bounds.left, rect.left);
      bounds.right = Math.min(bounds.right, rect.right);
      bounds.top = Math.max(bounds.top, rect.top);
      bounds.bottom = Math.min(bounds.bottom, rect.bottom);
    }

    return bounds;
  }

  function normalizeText(value) {
    return value.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").trim();
  }

  function render() {
    renderList();
    renderHitboxes();
    renderSelectionBoxes();
    updateCopyState();
  }

  function renderList() {
    if (!listEl) return;
    listEl.textContent = "";

    const sorted = sortedSelections();
    if (!sorted.length) {
      const empty = document.createElement("li");
      empty.className = "csc-empty";
      empty.textContent = "まだ選択がありません";
      listEl.appendChild(empty);
      return;
    }

    for (const selection of sorted) {
      const item = document.createElement("li");
      const text = document.createElement("span");
      const actions = document.createElement("span");
      const addOne = document.createElement("button");
      const remove = document.createElement("button");

      text.className = "csc-item-text";
      text.textContent = formatSelection(selection);

      actions.className = "csc-item-actions";

      addOne.type = "button";
      addOne.className = "csc-cal-one";
      addOne.textContent = "📅";
      addOne.title = "この候補をGoogleカレンダーに登録";
      addOne.setAttribute("aria-label", formatSelection(selection) + "をカレンダーに登録");
      addOne.addEventListener("click", () => registerToCalendar([selection]), {
        signal: uiAbort.signal,
      });

      remove.type = "button";
      remove.className = "csc-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", formatSelection(selection) + "を削除");
      remove.addEventListener("click", () => removeSelection(selection.id), {
        signal: uiAbort.signal,
      });

      actions.append(addOne, remove);
      item.append(text, actions);
      listEl.appendChild(item);
    }
  }

  function renderHitboxes() {
    if (!overlayEl) return;
    overlayEl.querySelectorAll(".csc-hitbox").forEach((element) => element.remove());
    if (!layout) return;

    for (const column of layout.columns) {
      const hitbox = document.createElement("div");
      hitbox.className = "csc-hitbox";
      hitbox.style.left = String(column.left) + "px";
      hitbox.style.top = String(column.visibleTop) + "px";
      hitbox.style.width = String(column.right - column.left) + "px";
      hitbox.style.height = String(column.visibleBottom - column.visibleTop) + "px";
      hitbox.dataset.dateKey = column.dateKey;
      hitbox.addEventListener("mousedown", (event) => startDrawing(event, column), {
        signal: uiAbort.signal,
      });
      overlayEl.appendChild(hitbox);
    }
  }

  function renderSelectionBoxes() {
    if (!overlayEl) return;
    overlayEl.querySelectorAll(".csc-box:not(.csc-drawing)").forEach((element) => element.remove());
    if (!layout) return;

    for (const selection of selections) {
      const column = layout.columns.find((item) => item.dateKey === selection.dateKey);
      if (!column) continue;

      const top = Math.max(column.visibleTop, minutesToY(column, selection.startMin));
      const bottom = Math.min(column.visibleBottom, minutesToY(column, selection.endMin));
      if (bottom - top < 2) continue;

      const box = document.createElement("div");
      box.className = "csc-box";
      box.style.left = String(column.left) + "px";
      box.style.top = String(top) + "px";
      box.style.width = String(column.right - column.left) + "px";
      box.style.height = String(Math.max(4, bottom - top)) + "px";
      box.title = "クリックで削除";
      box.textContent = formatTime(selection.startMin) + "-" + formatTime(selection.endMin);
      box.addEventListener("mousedown", (event) => event.stopPropagation(), {
        signal: uiAbort.signal,
      });
      box.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSelection(selection.id);
      }, { signal: uiAbort.signal });
      overlayEl.appendChild(box);
    }
  }

  function startDrawing(event, initialColumn) {
    if (event.button !== 0 || !layout) return;

    const fresh = calculateLayout();
    if (!fresh.valid) {
      layout = null;
      showWarning(fresh.reason);
      showDebug(fresh.debugLines || []);
      render();
      return;
    }

    layout = fresh;
    const column = layout.columns.find((item) => item.dateKey === initialColumn.dateKey);
    if (!column) return;

    cancelDrawing();
    drawingAbort = new AbortController();
    const startRaw = clampMinutes(minutesFromY(column, event.clientY));
    const ghost = document.createElement("div");
    ghost.className = "csc-box csc-drawing";
    overlayEl.appendChild(ghost);

    drawing = {
      column,
      startRaw,
      endRaw: startRaw,
      ghost,
    };
    updateGhost();

    window.addEventListener(
      "mousemove",
      (moveEvent) => {
        if (!drawing) return;
        drawing.endRaw = clampMinutes(minutesFromY(drawing.column, moveEvent.clientY));
        updateGhost();
      },
      { signal: drawingAbort.signal }
    );
    window.addEventListener(
      "mouseup",
      (upEvent) => finishDrawing(upEvent.clientY),
      { once: true, signal: drawingAbort.signal }
    );
    event.preventDefault();
  }

  function updateGhost() {
    if (!drawing) return;
    const range = snappedRange(drawing.startRaw, drawing.endRaw);
    const column = drawing.column;
    const top = Math.max(column.visibleTop, minutesToY(column, range.startMin));
    const bottom = Math.min(column.visibleBottom, minutesToY(column, range.endMin));

    drawing.ghost.style.left = String(column.left) + "px";
    drawing.ghost.style.top = String(top) + "px";
    drawing.ghost.style.width = String(column.right - column.left) + "px";
    drawing.ghost.style.height = String(Math.max(2, bottom - top)) + "px";
  }

  function finishDrawing(endY) {
    if (!drawing) return;

    const completed = drawing;
    const fresh = calculateLayout();
    cancelDrawing();

    if (!fresh.valid) {
      layout = null;
      showWarning(fresh.reason);
      showDebug(fresh.debugLines || []);
      render();
      return;
    }

    layout = fresh;
    const column = layout.columns.find((item) => item.dateKey === completed.column.dateKey);
    if (!column) {
      showWarning("選択した日付が表示中ではなくなりました。");
      render();
      return;
    }

    const endRaw = clampMinutes(minutesFromY(column, endY));
    const range = snappedRange(completed.startRaw, endRaw);
    addSelection({
      dateKey: column.dateKey,
      startMin: range.startMin,
      endMin: range.endMin,
    });
    render();
  }

  function cancelDrawing(message) {
    if (drawingAbort) drawingAbort.abort();
    if (drawing && drawing.ghost) drawing.ghost.remove();
    drawingAbort = null;
    drawing = null;
    if (message) showWarning(message);
  }

  function minutesToY(column, minutes) {
    return column.gridTop + (minutes / DAY_MINUTES) * column.gridHeight;
  }

  function minutesFromY(column, y) {
    return ((y - column.gridTop) / column.gridHeight) * DAY_MINUTES;
  }

  function snappedRange(first, second) {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    let startMin = Math.floor(low / SNAP_MINUTES) * SNAP_MINUTES;
    let endMin = Math.ceil(high / SNAP_MINUTES) * SNAP_MINUTES;

    startMin = Math.max(0, Math.min(DAY_MINUTES - SNAP_MINUTES, startMin));
    endMin = Math.max(startMin + SNAP_MINUTES, Math.min(DAY_MINUTES, endMin));
    return { startMin, endMin };
  }

  function clampMinutes(minutes) {
    return Math.max(0, Math.min(DAY_MINUTES, minutes));
  }

  function addSelection(selection) {
    const otherDates = selections.filter((item) => item.dateKey !== selection.dateKey);
    const intervals = selections
      .filter((item) => item.dateKey === selection.dateKey)
      .map((item) => ({ startMin: item.startMin, endMin: item.endMin }))
      .concat({ startMin: selection.startMin, endMin: selection.endMin })
      .sort((a, b) => a.startMin - b.startMin);

    const merged = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (last && interval.startMin <= last.endMin) {
        last.endMin = Math.max(last.endMin, interval.endMin);
      } else {
        merged.push({ startMin: interval.startMin, endMin: interval.endMin });
      }
    }

    selections = otherDates.concat(
      merged.map((interval) => ({
        id: selection.dateKey + "-" + String(interval.startMin) + "-" + String(interval.endMin),
        dateKey: selection.dateKey,
        startMin: interval.startMin,
        endMin: interval.endMin,
      }))
    );
  }

  function removeSelection(id) {
    selections = selections.filter((selection) => selection.id !== id);
    render();
  }

  function sortedSelections() {
    return selections.slice().sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
      return a.startMin - b.startMin;
    });
  }

  function formatSelection(selection) {
    const parts = selection.dateKey.split("-").map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return (
      String(parts[1]) +
      "月" +
      String(parts[2]) +
      "日(" +
      WEEKDAY_KANJI[date.getDay()] +
      ") " +
      formatTime(selection.startMin) +
      "-" +
      formatTime(selection.endMin)
    );
  }

  function formatTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return String(hours) + ":" + String(remaining).padStart(2, "0");
  }

  function updateCopyState() {
    const disabled = selections.length === 0;
    if (copyBtnEl) copyBtnEl.disabled = disabled;
    if (addToCalBtnEl && !addToCalBtnEl.dataset.busy) addToCalBtnEl.disabled = disabled;
  }

  async function onCopy() {
    if (!selections.length) {
      showWarning("コピーする候補日時を選択してください。");
      return;
    }

    const label = labelInputEl.value.trim();
    const lines = sortedSelections().map(formatSelection);
    const text = (label ? label + "\n" : "") + lines.join("\n");

    try {
      await copyText(text);
      flashCopyResult("コピーしました ✓", true);
    } catch (error) {
      flashCopyResult("コピーに失敗しました", false);
      showWarning("クリップボードへコピーできませんでした。ブラウザの権限を確認してください。");
    }
  }

  function onAddAllToCalendar() {
    registerToCalendar(sortedSelections());
  }

  // 選んだ候補を Google Calendar API で実際の予定として作成する（保存まで自動）。
  // OAuth クライアントID未設定・認証拒否などでAPI作成できない場合は、
  // 予定作成画面をタブで開く方式にフォールバックして、必ず登録操作に進めるようにする。
  async function registerToCalendar(items) {
    if (!items || !items.length) {
      showWarning("カレンダーに登録する候補日時を選択してください。");
      return;
    }

    const title = (labelInputEl && labelInputEl.value.trim()) || "予定";
    const timeZone = detectTimeZone();
    const events = items.map((selection) => ({
      start: localDateTime(selection, selection.startMin),
      end: localDateTime(selection, selection.endMin),
    }));

    setCalendarBusy(true, "登録中…");

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "CSC_CREATE_EVENTS",
        events,
        title,
        timeZone,
      });
    } catch (error) {
      response = { ok: false, message: error && error.message ? error.message : String(error) };
    }

    setCalendarBusy(false);

    if (response && response.ok) {
      flashCalendarResult(String(response.created) + "件を登録しました ✓", true);
      if (response.failed) {
        showWarning(String(response.failed) + "件は登録に失敗しました。時間をおいて再度お試しください。");
      } else {
        showWarning("");
      }
      return;
    }

    if (response && response.code === "NO_CLIENT_ID") {
      openSettings();
      showWarning(
        "予定を自動作成するには⚙Google連携設定でOAuthクライアントIDを設定してください。今回は予定作成画面を開きます。"
      );
    } else {
      showWarning(
        "APIでの登録に失敗しました（" +
          ((response && response.message) || "不明なエラー") +
          "）。予定作成画面を開きます。"
      );
    }
    openTemplateFallback(items);
  }

  function setCalendarBusy(busy, label) {
    if (!addToCalBtnEl) return;
    if (busy) {
      addToCalBtnEl.dataset.busy = "1";
      addToCalBtnEl.disabled = true;
      addToCalBtnEl.textContent = label || "登録中…";
    } else {
      delete addToCalBtnEl.dataset.busy;
      addToCalBtnEl.textContent = "カレンダーに登録";
      updateCopyState();
    }
  }

  function detectTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo";
    } catch (error) {
      return "Asia/Tokyo";
    }
  }

  // OAuth未設定や認証失敗時のフォールバック。各候補を予定作成画面（TEMPLATE URL）で開く。
  function openTemplateFallback(items) {
    let blocked = false;
    for (const selection of items) {
      const win = window.open(calendarTemplateUrl(selection), "_blank", "noopener");
      if (!win) blocked = true;
    }
    if (blocked) {
      showWarning(
        "ポップアップがブロックされました。このサイトのポップアップを許可するか、各候補の📅から1件ずつ開いてください。"
      );
    }
  }

  function calendarTemplateUrl(selection) {
    const start = compactStamp(selection, selection.startMin);
    const end = compactStamp(selection, selection.endMin);
    const title = (labelInputEl && labelInputEl.value.trim()) || "予定";
    return (
      "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" +
      encodeURIComponent(title) +
      "&dates=" +
      start +
      "/" +
      end
    );
  }

  // API用のローカル時刻文字列(YYYY-MM-DDTHH:MM:SS, オフセットなし)。timeZoneフィールドと併せて渡す。
  function localDateTime(selection, minutes) {
    const date = dateFromSelection(selection, minutes);
    const p2 = (n) => String(n).padStart(2, "0");
    return (
      String(date.getFullYear()) +
      "-" +
      p2(date.getMonth() + 1) +
      "-" +
      p2(date.getDate()) +
      "T" +
      p2(date.getHours()) +
      ":" +
      p2(date.getMinutes()) +
      ":00"
    );
  }

  // TEMPLATE URL用のコンパクト表記(YYYYMMDDTHHMMSS)。
  function compactStamp(selection, minutes) {
    const date = dateFromSelection(selection, minutes);
    const p2 = (n) => String(n).padStart(2, "0");
    return (
      String(date.getFullYear()) +
      p2(date.getMonth() + 1) +
      p2(date.getDate()) +
      "T" +
      p2(date.getHours()) +
      p2(date.getMinutes()) +
      "00"
    );
  }

  // 分(0-1440)をその日基準のDateへ。終了24:00(=1440分)は翌日00:00へ正しく繰り上がる。
  function dateFromSelection(selection, minutes) {
    const parts = selection.dateKey.split("-").map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    date.setMinutes(date.getMinutes() + minutes);
    return date;
  }

  async function loadConfig() {
    let config;
    try {
      config = await chrome.runtime.sendMessage({ type: "CSC_GET_CONFIG" });
    } catch (error) {
      config = null;
    }
    if (!config || !config.ok) return;
    if (redirectUriEl) redirectUriEl.textContent = config.redirectUri || "";
    if (clientIdInputEl) clientIdInputEl.value = config.clientId || "";
    setSettingsStatus(config.clientId ? "設定済み" : "未設定", Boolean(config.clientId));
  }

  async function onSaveClientId() {
    if (!clientIdInputEl) return;
    const value = clientIdInputEl.value.trim();
    try {
      await chrome.storage.local.set({ csc_client_id: value });
      setSettingsStatus(value ? "保存しました ✓" : "クリアしました", Boolean(value));
    } catch (error) {
      setSettingsStatus("保存に失敗しました", false);
    }
  }

  function setSettingsStatus(message, ok) {
    if (!settingsStatusEl) return;
    settingsStatusEl.textContent = message;
    settingsStatusEl.classList.toggle("csc-settings-ok", Boolean(ok));
  }

  function openSettings() {
    if (settingsBodyEl) settingsBodyEl.style.display = "block";
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // User activation or clipboard permission may be unavailable. Use the page fallback below.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText =
      "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard copy was rejected");
  }

  function flashCopyResult(message, success) {
    if (!copyBtnEl) return;
    const original = "コピーする";
    copyBtnEl.textContent = message;
    copyBtnEl.classList.toggle("csc-btn-copied", success);
    window.setTimeout(() => {
      if (!copyBtnEl) return;
      copyBtnEl.textContent = original;
      copyBtnEl.classList.remove("csc-btn-copied");
      updateCopyState();
    }, 1500);
  }

  function flashCalendarResult(message, success) {
    if (!addToCalBtnEl) return;
    const original = "カレンダーに登録";
    addToCalBtnEl.textContent = message;
    addToCalBtnEl.classList.toggle("csc-btn-calendar-done", success);
    window.setTimeout(() => {
      if (!addToCalBtnEl) return;
      addToCalBtnEl.textContent = original;
      addToCalBtnEl.classList.remove("csc-btn-calendar-done");
      updateCopyState();
    }, 1500);
  }

  function showWarning(message) {
    if (!warningEl) return;
    warningEl.textContent = message ? "⚠ " + message : "";
    warningEl.style.display = message ? "block" : "none";
  }

  function showDebug(lines) {
    if (!debugEl || !debugPreEl || !lines.length) {
      clearDebug();
      return;
    }
    debugPreEl.textContent = lines.join("\n");
    debugEl.style.display = "block";
  }

  function clearDebug() {
    if (debugEl) debugEl.style.display = "none";
    if (debugPreEl) debugPreEl.textContent = "";
  }

  function showFatalError(error) {
    const box = document.createElement("div");
    box.className = "csc-fatal";
    box.textContent =
      "[候補日コピー] エラーが発生しました。拡張機能を閉じて、もう一度開いてください。\n\n" +
      String(error && error.message ? error.message : error);
    document.body.appendChild(box);
    console.error("[候補日コピー]", error);
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function formatDateKey(date) {
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join("-");
  }
})();
