function parseSpreadsheetId(url) {
  // スプレッドシートURLからドキュメントIDを抽出する。
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : "";
}

function parseFilterViewId(url) {
  // URLからフィルタビューIDを抽出する（query優先、次にhash）。
  try {
    // query の fvid を優先し、無ければ hash から取得する。
    const parsedUrl = new URL(url);
    const fromQuery = parsedUrl.searchParams.get("fvid");
    if (fromQuery) {
      return fromQuery;
    }

    const hashText = parsedUrl.hash.startsWith("#")
      ? parsedUrl.hash.slice(1)
      : parsedUrl.hash;
    const hashParams = new URLSearchParams(hashText);
    return hashParams.get("fvid") || "";
  } catch {
    return "";
  }
}

function parseSheetId(url) {
  // URLからシートIDを抽出する（query優先、次にhash）。
  try {
    // query の gid を優先し、無ければ hash から取得する。
    const parsedUrl = new URL(url);
    const fromQuery = parsedUrl.searchParams.get("gid");
    if (fromQuery) {
      return fromQuery;
    }

    const hashText = parsedUrl.hash.startsWith("#")
      ? parsedUrl.hash.slice(1)
      : parsedUrl.hash;
    const hashParams = new URLSearchParams(hashText);
    return hashParams.get("gid") || "";
  } catch {
    return "";
  }
}

function parseUrlTail(url) {
  // 現在URLの query + hash を1本の文字列として取り出す。
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return "";
  }
}

function getSheetContext() {
  // URL と DOM の両方から、現在のシート/フィルタ状態を集約する。
  const currentUrl = window.location.href;
  const filterNameElement = document.querySelector(".waffle-slidingdialog-filterbar");
  const filterNameReadonlyElement = document.getElementById("waffle-filterbar-name-readonly");
  const sheetNameElement = document.querySelector(".docs-sheet-active-tab .docs-sheet-tab-caption .docs-sheet-tab-name");
  const isFilterBarVisible = (filterNameElement instanceof HTMLElement)
    && filterNameElement?.style?.marginTop === "0px";
  const currentFilterName = filterNameReadonlyElement
    ? String(filterNameReadonlyElement.textContent || "").trim()
    : "";
  const currentSheetName = sheetNameElement
    ? String(sheetNameElement.textContent || "").trim()
    : "";
  const cleanedTitle = document.title
    .replace(/\s*-\s*Google\s+Sheets\s*$/i, "")
    .replace(/\s*-\s*Google\s*スプレッドシート\s*$/i, "")
    .trim();

  return {
    isGoogleSheets: currentUrl.includes("docs.google.com/spreadsheets/"),
    spreadsheetId: parseSpreadsheetId(currentUrl),
    filterViewId: parseFilterViewId(currentUrl),
    currentSheetId: parseSheetId(currentUrl),
    currentFilterName,
    isFilterBarVisible,
    currentSheetName,
    spreadsheetTitle: cleanedTitle,
    url: currentUrl
  };
}

const INLINE_ROOT_ID = "gsfv-inline-favorites";
const INLINE_STYLE_LINK_ID = "gsfv-inline-style-link";
const FAVORITE_TOGGLE_BUTTON_ID = "gsfv-inline-favorite-toggle";
const CHIP_MENU_ID = "gsfv-chip-menu";
const URL_CHANGE_EVENT = "gsfv-url-change";
const URL_OBSERVER_FLAG = "__gsfvUrlObserverInstalled";
const URL_POLL_INTERVAL_MS = 100;

let renderTimerId = 0;
let isRendering = false;
let hasPendingRender = false;
let isInlineListCollapsed = false;
let lastRenderSignature = "";
let chipMenuController = null;
let dragFilterViewId = "";
let pendingAddedFavoriteKey = "";
let visibilityLoadedSpreadsheetId = "";
let lastObservedUrl = "";
let urlPollTimerId = 0;

function getUrlParamsText(url) {
  // パラメータ編集欄へ入れる文字列の取得を1か所に集約する。
  return parseUrlTail(url);
}

function getFavoriteUrlParams(favorite) {
  // 保存済みの urlParams を優先し、旧データは sheetId/filterViewId から補完する。
  const direct = typeof favorite.urlParams === "string" ? favorite.urlParams.trim() : "";
  if (direct) {
    return direct;
  }

  const safeSheetId = typeof favorite.sheetId === "string" ? favorite.sheetId.trim() : "";
  const safeFilterViewId = typeof favorite.filterViewId === "string" ? favorite.filterViewId.trim() : "";
  if (!safeSheetId) {
    return "";
  }
  if (!safeFilterViewId) {
    return `?gid=${encodeURIComponent(safeSheetId)}`;
  }
  return `?gid=${encodeURIComponent(safeSheetId)}#gid=${encodeURIComponent(safeSheetId)}&fvid=${encodeURIComponent(safeFilterViewId)}`;
}

function buildUrlParamsSignature(urlLikeText) {
  // 「?」以降（query + hash）のパラメータを順序差なしで比較できる形へ正規化する。
  const text = String(urlLikeText || "").trim();
  if (!text) {
    return "";
  }

  const questionIndex = text.indexOf("?");
  const tail = questionIndex >= 0 ? text.slice(questionIndex) : text;
  if (!tail.startsWith("?") && !tail.startsWith("#")) {
    return "";
  }

  const hashIndex = tail.indexOf("#");
  const queryText = tail.startsWith("#")
    ? ""
    : (hashIndex >= 0 ? tail.slice(1, hashIndex) : tail.slice(1));
  const hashText = hashIndex >= 0
    ? tail.slice(hashIndex + 1)
    : (tail.startsWith("#") ? tail.slice(1) : "");

  const pairs = [];
  const queryParams = new URLSearchParams(queryText);
  queryParams.forEach((value, key) => {
    pairs.push([`q:${key}`, value]);
  });

  const hashParams = new URLSearchParams(hashText);
  hashParams.forEach((value, key) => {
    pairs.push([`h:${key}`, value]);
  });

  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) {
      return leftKey.localeCompare(rightKey);
    }
    return leftValue.localeCompare(rightValue);
  });

  return pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function buildFavoriteKey(filterViewId = "", sheetId = "") {
  // active判定用の簡易キー。
  return `f:${String(filterViewId || "")}|s:${String(sheetId || "")}`;
}

function buildFavoriteOrderKey(favorite) {
  // D&D 並び替え用の一意キー（重複filterViewIdでも衝突しない）。
  const filterViewId = typeof favorite.filterViewId === "string" ? favorite.filterViewId : "";
  const sheetId = typeof favorite.sheetId === "string" ? favorite.sheetId : "";
  const createdAt = typeof favorite.createdAt === "string" ? favorite.createdAt : "";
  return `f:${filterViewId}|s:${sheetId}|c:${createdAt}`;
}

function normalizeSubstitutions(substitutions) {
  // getMessage に渡せる形（string or string[]）へ揃える。
  if (substitutions === undefined || substitutions === null) {
    return undefined;
  }
  if (Array.isArray(substitutions)) {
    return substitutions.map((value) => String(value));
  }
  return String(substitutions);
}

function t(key, substitutions) {
  // chrome.i18n を唯一の翻訳ソースとして使う。
  const normalized = normalizeSubstitutions(substitutions);
  const message = normalized === undefined
    ? chrome.i18n.getMessage(key)
    : chrome.i18n.getMessage(key, normalized);
  return message || key;
}

function getUnnamedFavoriteLabel() {
  // 名称未設定ラベルの取得を共通化する。
  return t("unnamedFavoriteLabel");
}

function createIconSvg(iconName) {
  // 共通SVGアイコン生成。呼び出し側はアイコン名のみ指定する。
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 26 26");
  svg.setAttribute("class", `gsfv-icon gsfv-icon-${iconName}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");

  if (iconName === "favorite") {
    path.setAttribute("d", "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z");
  } else if (iconName === "favorite-outline") {
    path.setAttribute("d", "M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.31C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z");
  } else if (iconName === "settings") {
    path.setAttribute("d", "M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.028 7.028 0 00-1.63-.94l-.36-2.54a.5.5 0 00-.49-.42h-3.84a.5.5 0 00-.49.42l-.36 2.54c-.58.23-1.13.54-1.63.94l-2.39-.96a.5.5 0 00-.6.22L2.71 8.84a.5.5 0 00.12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.6.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54a.5.5 0 00.49.42h3.84a.5.5 0 00.49-.42l.36-2.54c.58-.23 1.13-.54 1.63-.94l2.39.96a.5.5 0 00.6-.22l1.92-3.32a.5.5 0 00-.12-.64zM12 15.5A3.5 3.5 0 1112 8a3.5 3.5 0 010 7.5z");
  } else {
    path.setAttribute("d", "M19 13H13v6h-2v-6H5v-2h6V5h2v6h6z");
  }

  svg.appendChild(path);
  return svg;
}

function setButtonIcon(buttonElement, iconName) {
  // 既存アイコンを差し替えて、状態に応じた見た目へ更新する。
  buttonElement.replaceChildren(createIconSvg(iconName));
}

function emitUrlChange() {
  // URL変化を自前イベントとして統一通知する。
  window.dispatchEvent(new Event(URL_CHANGE_EVENT));
}

function observeUrlChanges() {
  if (window[URL_OBSERVER_FLAG]) {
    return;
  }
  // URLを短い間隔で監視し、hash 変更を含む遷移差分を取りこぼさないようにする。
  window[URL_OBSERVER_FLAG] = true;
  lastObservedUrl = window.location.href;

  if (urlPollTimerId) {
    window.clearInterval(urlPollTimerId);
  }

  urlPollTimerId = window.setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl === lastObservedUrl) {
      return;
    }

    lastObservedUrl = currentUrl;
    emitUrlChange();
  }, URL_POLL_INTERVAL_MS);
}

function ensureInlineStyle() {
  // CSSの重複挿入を避けつつ初回だけ読み込む。
  if (document.getElementById(INLINE_STYLE_LINK_ID)) {
    return;
  }

  const link = document.createElement("link");
  link.id = INLINE_STYLE_LINK_ID;
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("content.css");
  document.head.appendChild(link);
}

async function sendToBackground(payload) {
  // background通信の共通ラッパー。失敗時は例外で統一処理する。
  const response = await chrome.runtime.sendMessage(payload);
  if (!response || !response.ok) {
    const errorMessage = response && response.error ? response.error : t("unknownError");
    throw new Error(errorMessage);
  }
  return response.data;
}

async function loadInlineVisibility(spreadsheetId) {
  // スプレッドシート単位で保存された表示状態を読み込む。
  // 表示状態はスプレッドシート単位で保持する。
  if (!spreadsheetId) {
    return;
  }
  if (visibilityLoadedSpreadsheetId === spreadsheetId) {
    return;
  }

  try {
    const result = await sendToBackground({
      type: "GET_INLINE_VISIBILITY",
      spreadsheetId
    });
    const isVisible = !!(result && result.visible === true);
    isInlineListCollapsed = !isVisible;
  } catch {
    isInlineListCollapsed = true;
  }

  visibilityLoadedSpreadsheetId = spreadsheetId;
}

async function saveInlineVisibility(spreadsheetId, isVisible) {
  // インラインリストの表示状態をストレージへ保存する。
  // 表示状態は失敗してもUI操作を止めない。
  if (!spreadsheetId) {
    return;
  }

  try {
    await sendToBackground({
      type: "SET_INLINE_VISIBILITY",
      spreadsheetId,
      visible: !!isVisible
    });
  } catch {
    // 保存失敗時も表示状態はそのまま継続する。
  }
}

function getOrCreateInlineRoot(anchorElement) {
  // 既存ルートを再利用し、アンカー直下の位置を保つ。
  let root = document.getElementById(INLINE_ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = INLINE_ROOT_ID;
  }

  if (anchorElement.nextElementSibling !== root) {
    anchorElement.insertAdjacentElement("afterend", root);
  }

  return root;
}

function closeChipMenu() {
  // 開いているメニューとイベント購読を確実に破棄する。
  const existingMenu = document.getElementById(CHIP_MENU_ID);
  if (existingMenu) {
    existingMenu.remove();
  }
  if (chipMenuController) {
    chipMenuController.abort();
    chipMenuController = null;
  }
}

function openChipMenu(anchorElement, favorite, context) {
  // お気に入り1件に対する右クリック編集メニューを表示する。
  // 右クリックメニューは都度再生成して最新データを反映する。
  closeChipMenu();
  if (renderTimerId) {
    window.clearTimeout(renderTimerId);
    renderTimerId = 0;
  }

  const menu = document.createElement("div");
  menu.id = CHIP_MENU_ID;
  menu.className = "gsfv-chip-menu";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "gsfv-chip-menu-item";
  removeButton.textContent = t("removeFavorite");
  removeButton.classList.add("danger");
  removeButton.addEventListener("click", async (event) => {
    // 削除操作はメニュー経由で実行し、完了後に一覧を再描画する。
    event.preventDefault();
    event.stopPropagation();
    try {
      await sendToBackground({
        type: "DELETE_FAVORITE",
        spreadsheetId: context.spreadsheetId,
        filterViewId: favorite.filterViewId,
        sourceSheetId: favorite.sheetId || ""
      });
    } catch {
      // 失敗時でもメニューは閉じる。
    } finally {
      closeChipMenu();
      scheduleInlineRender();
    }
  });

  const editPanel = document.createElement("div");
  editPanel.className = "gsfv-chip-menu-edit";

  const nameLabel = document.createElement("label");
  nameLabel.className = "gsfv-chip-menu-label";
  nameLabel.textContent = t("editNameLabel");
  const nameInput = document.createElement("input");
  nameInput.className = "gsfv-chip-menu-input";
  nameInput.type = "text";
  nameInput.maxLength = 120;
  nameInput.placeholder = getUnnamedFavoriteLabel();
  nameInput.value = favorite.label || "";
  nameLabel.appendChild(nameInput);

  const filterIdLabel = document.createElement("label");
  filterIdLabel.className = "gsfv-chip-menu-label";
  filterIdLabel.textContent = t("editParamsLabel");

  const filterIdFieldRow = document.createElement("div");
  filterIdFieldRow.className = "gsfv-chip-menu-field-row";

  const filterIdInput = document.createElement("input");
  filterIdInput.className = "gsfv-chip-menu-input";
  filterIdInput.type = "text";
  filterIdInput.maxLength = 2048;
  filterIdInput.placeholder = "?gid=...#gid=...&fvid=...";
  filterIdInput.value = getFavoriteUrlParams(favorite);

  const setCurrentFilterButton = document.createElement("button");
  setCurrentFilterButton.type = "button";
  setCurrentFilterButton.className = "gsfv-chip-menu-current-filter";
  setCurrentFilterButton.textContent = t("currentParams");
  setCurrentFilterButton.disabled = false;

  let autoSaveTimerId = 0;
  let isComposing = false;
  let lastSavedLabel = favorite.label || "";
  let lastSavedFilterViewId = favorite.filterViewId || "";
  let lastSavedUrlParams = getFavoriteUrlParams(favorite);

  const saveDetails = async () => {
    // 差分があるときだけ保存して不要な書き込みを避ける。
    const nextLabel = nameInput.value.trim() || getUnnamedFavoriteLabel();
    const nextSheetId = favorite.sheetId || "";
    const nextFilterViewId = favorite.filterViewId || "";
    const nextUrlParams = filterIdInput.value.trim();
    if (
      nextLabel === lastSavedLabel
      && nextFilterViewId === lastSavedFilterViewId
      && nextUrlParams === lastSavedUrlParams
    ) {
      return;
    }

    try {
      const updatedFavorite = await sendToBackground({
        type: "UPDATE_FAVORITE_DETAILS",
        spreadsheetId: context.spreadsheetId,
        filterViewId: favorite.filterViewId,
        sourceSheetId: favorite.sheetId || "",
        label: nextLabel,
        sheetId: nextSheetId,
        nextFilterViewId,
        nextUrlParams
      });

      favorite.label = updatedFavorite.label || nextLabel;
      favorite.sheetId = updatedFavorite.sheetId || "";
      favorite.filterViewId = updatedFavorite.filterViewId || "";
      favorite.urlParams = updatedFavorite.urlParams || nextUrlParams;
      lastSavedLabel = favorite.label;
      lastSavedFilterViewId = favorite.filterViewId;
      lastSavedUrlParams = favorite.urlParams;
      filterIdInput.value = favorite.urlParams;
      anchorElement.textContent = favorite.label;
      anchorElement.title = favorite.label;
      scheduleInlineRender();
    } catch {
      // 自動保存失敗時は入力を保持し、次回変更時に再試行する。
    }
  };

  const scheduleAutoSave = () => {
    // 入力中は短いディレイで保存をまとめる（デバウンス）。
    if (autoSaveTimerId) {
      window.clearTimeout(autoSaveTimerId);
    }
    autoSaveTimerId = window.setTimeout(() => {
      autoSaveTimerId = 0;
      void saveDetails();
    }, 280);
  };

  setCurrentFilterButton.addEventListener("click", (event) => {
    // 現在URLを入力欄へ反映し、同じ保存経路で更新する。
    event.preventDefault();
    event.stopPropagation();
    // 現在URLの query + hash をそのまま入力へ反映する。
    filterIdInput.value = getUrlParamsText(window.location.href);
    scheduleAutoSave();
  });

  const handleCompositionStart = () => {
    isComposing = true;
  };
  const handleCompositionEnd = () => {
    isComposing = false;
    scheduleAutoSave();
  };

  nameInput.addEventListener("compositionstart", handleCompositionStart);
  filterIdInput.addEventListener("compositionstart", handleCompositionStart);
  nameInput.addEventListener("compositionend", handleCompositionEnd);
  filterIdInput.addEventListener("compositionend", handleCompositionEnd);

  nameInput.addEventListener("input", () => {
    // IME変換中を除き、入力のたびに遅延保存を予約する。
    if (!isComposing) {
      scheduleAutoSave();
    }
  });
  filterIdInput.addEventListener("input", () => {
    // パラメータ欄も同じ保存ポリシーで扱う。
    if (!isComposing) {
      scheduleAutoSave();
    }
  });
  nameInput.addEventListener("blur", () => {
    // フォーカス離脱時は未保存を残さないよう即保存する。
    void saveDetails();
  });
  filterIdInput.addEventListener("blur", () => {
    // フォーカス離脱時は未保存を残さないよう即保存する。
    void saveDetails();
  });

  filterIdFieldRow.appendChild(filterIdInput);
  filterIdFieldRow.appendChild(setCurrentFilterButton);

  editPanel.appendChild(nameLabel);
  filterIdLabel.appendChild(filterIdFieldRow);
  editPanel.appendChild(filterIdLabel);

  const deleteDivider = document.createElement("div");
  deleteDivider.className = "gsfv-chip-menu-divider";

  menu.appendChild(editPanel);
  menu.appendChild(deleteDivider);
  menu.appendChild(removeButton);
  document.body.appendChild(menu);

  nameInput.focus();
  nameInput.select();

  const anchorRect = anchorElement.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const top = Math.min(
    window.innerHeight - menuRect.height - 8,
    anchorRect.bottom + 4
  );
  const left = Math.min(
    window.innerWidth - menuRect.width - 8,
    Math.max(8, anchorRect.left)
  );

  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${left}px`;

  chipMenuController = new AbortController();
  const openedAt = performance.now();
  const options = { capture: true, signal: chipMenuController.signal };
  document.addEventListener("pointerdown", (event) => {
    // メニュー外クリックで閉じる。ただし開いた直後の誤反応は無視する。
    if (performance.now() - openedAt < 120) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && menu.contains(target)) {
      return;
    }
    closeChipMenu();
  }, options);
  document.addEventListener("keydown", (event) => {
    // Escape キーで明示的にメニューを閉じる。
    if (event.key === "Escape") {
      closeChipMenu();
    }
  }, options);
  const viewportOptions = { signal: chipMenuController.signal };
  window.addEventListener("scroll", closeChipMenu, viewportOptions);
  window.addEventListener("resize", closeChipMenu, viewportOptions);
}

async function toggleCurrentFavorite(context, isAlreadyFavorite) {
  // 現在のシート/フィルタ状態をお気に入りへ追加・削除する。
  if (!context.spreadsheetId) {
    return "";
  }

  if (isAlreadyFavorite) {
    await sendToBackground({
      type: "DELETE_FAVORITE",
      spreadsheetId: context.spreadsheetId,
      filterViewId: context.filterViewId
    });
    return "";
  } else {
    const fallbackLabel = context.currentSheetName || context.spreadsheetTitle || getUnnamedFavoriteLabel();
    const nextLabel = context.isFilterBarVisible
      ? (context.currentFilterName || fallbackLabel)
      : fallbackLabel;
    const addedFavorite = await sendToBackground({
      type: "ADD_FAVORITE",
      spreadsheetId: context.spreadsheetId,
      spreadsheetTitle: context.spreadsheetTitle,
      filterViewId: context.filterViewId,
      label: nextLabel,
      sheetId: context.currentSheetId,
      urlParams: getUrlParamsText(context.url)
    });
    return buildFavoriteKey(addedFavorite.filterViewId, addedFavorite.sheetId);
  }
}

async function reorderFavoritesByDrop(context, favorites, sourceOrderKey, targetOrderKey, insertBefore) {
  // D&D結果から新しい並び順を計算し、backgroundへ保存する。
  // ドラッグ&ドロップ後の順序をfilterViewId配列で保存する。
  if (!sourceOrderKey || !targetOrderKey || sourceOrderKey === targetOrderKey) {
    return;
  }

  const sourceIndex = favorites.findIndex((item) => buildFavoriteOrderKey(item) === sourceOrderKey);
  const targetIndex = favorites.findIndex((item) => buildFavoriteOrderKey(item) === targetOrderKey);
  if (sourceIndex < 0 || targetIndex < 0) {
    return;
  }

  const ordered = favorites.map((item) => buildFavoriteOrderKey(item));
  const [moved] = ordered.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertIndex = insertBefore ? adjustedTargetIndex : adjustedTargetIndex + 1;
  ordered.splice(insertIndex, 0, moved);

  await sendToBackground({
    type: "REORDER_FAVORITES",
    spreadsheetId: context.spreadsheetId,
    orderedFavoriteKeys: ordered
  });
}

async function applyFavorite(filterViewId, currentUrl, sheetId = "", urlParams = "") {
  // 適用先URLは background 側で一元生成する。
  const result = await sendToBackground({
    type: "BUILD_APPLY_URL",
    url: currentUrl,
    filterViewId,
    sheetId,
    urlParams
  });

  if (!result || !result.url || result.url === window.location.href) {
    return;
  }

  const current = new URL(window.location.href);
  const next = new URL(result.url);
  const isSameDocument = current.origin === next.origin && current.pathname === next.pathname;

  if (!isSameDocument) {
    // ドキュメント自体が異なる場合は通常遷移で切り替える。
    window.location.assign(result.url);
    return;
  }

  if (current.search !== next.search) {
    // 同一ドキュメント内ではまず query を差し替えて再描画を促す。
    const urlWithNextSearch = `${next.pathname}${next.search}${current.hash}`;
    window.history.replaceState(window.history.state, "", urlWithNextSearch);
    emitUrlChange();
  }

  if (current.hash !== next.hash) {
    // hash は location 経由で更新し、Sheets側の反応を期待する。
    window.location.hash = next.hash;
    return;
  }
}

async function renderInlineFavorites() {
  // 多重描画を防ぎつつ、最新の状態でUIを再構築する。
  if (isRendering) {
    hasPendingRender = true;
    return;
  }

  isRendering = true;
  try {
    const context = getSheetContext();
    const editorSizedBarElement = document.getElementById("waffle-editorsized-bar");
    const titlebarBadgesElement = document.querySelector(".docs-titlebar-badges");
    if (!context.isGoogleSheets || !context.spreadsheetId || !editorSizedBarElement) {
      const existingRoot = document.getElementById(INLINE_ROOT_ID);
      const existingFavoriteToggle = document.getElementById(FAVORITE_TOGGLE_BUTTON_ID);
      if (existingRoot) {
        existingRoot.remove();
      }
      if (existingFavoriteToggle) {
        existingFavoriteToggle.remove();
      }
      lastRenderSignature = "";
      visibilityLoadedSpreadsheetId = "";
      return;
    }

    ensureInlineStyle();
    await loadInlineVisibility(context.spreadsheetId);

    const favorites = await sendToBackground({
      type: "GET_FAVORITES",
      spreadsheetId: context.spreadsheetId
    });

    const signatureItems = favorites.map((item) => `${item.filterViewId}:${item.label || ""}:${item.sheetId || ""}:${item.urlParams || ""}`).join("|");
    const currentSignature = [
      context.spreadsheetId,
      context.filterViewId,
      context.currentSheetId,
      context.currentFilterName,
      isInlineListCollapsed ? "1" : "0",
      signatureItems
    ].join("||");

    // 署名が同じならDOM再構築をスキップして負荷を抑える。
    const existingRoot = document.getElementById(INLINE_ROOT_ID);
    const existingFavoriteToggle = document.getElementById(FAVORITE_TOGGLE_BUTTON_ID);
    const isFavoriteToggleInExpectedPosition = titlebarBadgesElement
      ? titlebarBadgesElement.lastElementChild === existingFavoriteToggle
      : !!existingFavoriteToggle;
    if (
      existingRoot
      && currentSignature === lastRenderSignature
      && editorSizedBarElement.nextElementSibling === existingRoot
      && isFavoriteToggleInExpectedPosition
    ) {
      return;
    }

    const root = getOrCreateInlineRoot(editorSizedBarElement);
    root.textContent = "";
    root.classList.toggle("collapsed", isInlineListCollapsed);
    closeChipMenu();

    // お気に入りリストの左端に常時表示するお気に入りアイコン。
    const leadingFavorite = document.createElement("span");
    leadingFavorite.className = "gsfv-leading-favorite";
    leadingFavorite.setAttribute("aria-hidden", "true");
    leadingFavorite.appendChild(createIconSvg("favorite"));

    const chipList = document.createElement("div");
    chipList.className = "gsfv-chip-list";

    const isAlreadyFavorite = favorites.some((item) => (
      (item.filterViewId || "") === (context.filterViewId || "")
      && (item.sheetId || "") === (context.currentSheetId || "")
    ));
    if (existingFavoriteToggle) {
      existingFavoriteToggle.remove();
    }

    const favoriteToggleButton = document.createElement("button");
    favoriteToggleButton.id = FAVORITE_TOGGLE_BUTTON_ID;
    favoriteToggleButton.type = "button";
    favoriteToggleButton.className = "gsfv-favorite-toggle";
    setButtonIcon(favoriteToggleButton, isInlineListCollapsed ? "favorite-outline" : "favorite");
    favoriteToggleButton.title = t("toggleList");
    favoriteToggleButton.setAttribute("aria-label", t("toggleList"));
    favoriteToggleButton.setAttribute("aria-expanded", isInlineListCollapsed ? "false" : "true");

    favoriteToggleButton.addEventListener("click", async (event) => {
      // 展開/折りたたみ状態を即反映し、状態をストレージへ保存する。
      event.preventDefault();
      event.stopPropagation();
      isInlineListCollapsed = !isInlineListCollapsed;
      root.classList.toggle("collapsed", isInlineListCollapsed);
      setButtonIcon(favoriteToggleButton, isInlineListCollapsed ? "favorite-outline" : "favorite");
      favoriteToggleButton.setAttribute("aria-expanded", isInlineListCollapsed ? "false" : "true");
      void saveInlineVisibility(context.spreadsheetId, !isInlineListCollapsed);
    });

    if (titlebarBadgesElement) {
      titlebarBadgesElement.appendChild(favoriteToggleButton);
    } else {
      root.appendChild(favoriteToggleButton);
    }

    const currentFilterViewId = context.filterViewId || "";
    const currentSheetId = context.currentSheetId || "";
    let prioritizedActiveKey = "";

    const currentUrlParamsSignature = buildUrlParamsSignature(context.url);
    if (currentUrlParamsSignature) {
      // URL変更時（hash変更含む）は「?以降のパラメータ一致」を最優先でactiveにする。
      const paramsMatchedFavorite = favorites.find((item) => {
        const favoriteUrlParamsSignature = buildUrlParamsSignature(getFavoriteUrlParams(item));
        return favoriteUrlParamsSignature && favoriteUrlParamsSignature === currentUrlParamsSignature;
      });
      if (paramsMatchedFavorite) {
        prioritizedActiveKey = buildFavoriteKey(paramsMatchedFavorite.filterViewId, paramsMatchedFavorite.sheetId);
      }
    }

    if (!prioritizedActiveKey && currentSheetId) {
      // active判定は「sheet+filter一致」を最優先、次に「sheet一致」。
      const exactMatchedFavorite = favorites.find((item) => {
        const itemFilterViewId = item.filterViewId || "";
        const itemSheetId = item.sheetId || "";
        return itemSheetId === currentSheetId && itemFilterViewId && itemFilterViewId === currentFilterViewId;
      });

      if (exactMatchedFavorite) {
        prioritizedActiveKey = buildFavoriteKey(exactMatchedFavorite.filterViewId, exactMatchedFavorite.sheetId);
      } else {
        const sheetMatchedFavorite = favorites.find((item) => (item.sheetId || "") === currentSheetId);
        if (sheetMatchedFavorite) {
          prioritizedActiveKey = buildFavoriteKey(sheetMatchedFavorite.filterViewId, sheetMatchedFavorite.sheetId);
        }
      }
    }

    let consumedAddedFavoriteKey = false;
    favorites.forEach((favorite) => {
      const favoriteKey = buildFavoriteKey(favorite.filterViewId, favorite.sheetId);
      const favoriteOrderKey = buildFavoriteOrderKey(favorite);
      const isActive = !!prioritizedActiveKey && favoriteKey === prioritizedActiveKey;

      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `gsfv-chip${isActive ? " active" : ""}`;
      if (pendingAddedFavoriteKey && pendingAddedFavoriteKey === favoriteKey) {
        chip.classList.add("gsfv-chip-added");
        consumedAddedFavoriteKey = true;
      }
      chip.draggable = true;
      chip.dataset.filterViewId = favorite.filterViewId;
      chip.dataset.orderKey = favoriteOrderKey;
      chip.textContent = favorite.label || favorite.filterViewId;
      chip.title = favorite.label || favorite.filterViewId;
      chip.addEventListener("click", async (event) => {
        // チップクリックで対象のお気に入りを適用する。
        event.preventDefault();
        event.stopPropagation();
        try {
          await applyFavorite(
            favorite.filterViewId,
            window.location.href,
            favorite.sheetId || "",
            getFavoriteUrlParams(favorite)
          );
        } catch {
          // 無視: 画面操作は既存UIのまま継続
        } finally {
          scheduleInlineRender({ immediate: true });
        }
      });
      chip.addEventListener("contextmenu", (event) => {
        // 右クリック時はドラッグを一時無効化して編集メニューを開く。
        event.preventDefault();
        event.stopPropagation();
        chip.draggable = false;
        openChipMenu(chip, favorite, context);
        window.setTimeout(() => {
          chip.draggable = true;
        }, 0);
      });
      chip.addEventListener("pointerdown", (event) => {
        // 左クリック開始時のみドラッグ可能にする。
        chip.draggable = event.button === 0;
      });
      chip.addEventListener("pointerup", () => {
        // ポインタ操作終了後はドラッグ可否を初期状態へ戻す。
        chip.draggable = true;
      });
      chip.addEventListener("pointercancel", () => {
        // キャンセル時も同様にドラッグ可否を復元する。
        chip.draggable = true;
      });
      chip.addEventListener("dragstart", (event) => {
        // ドラッグ開始時にsourceキーを保持し、見た目をドラッグ中へ変更する。
        if (!chip.draggable) {
          event.preventDefault();
          return;
        }
        dragFilterViewId = favoriteOrderKey;
        chip.classList.add("dragging");
        closeChipMenu();
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", favoriteOrderKey);
        }
      });
      chip.addEventListener("dragend", () => {
        // ドラッグ終了時に内部状態と挿入ガイド表示をリセットする。
        dragFilterViewId = "";
        chip.classList.remove("dragging");
        chipList.querySelectorAll(".drop-before, .drop-after").forEach((node) => {
          node.classList.remove("drop-before", "drop-after");
        });
      });
      chip.addEventListener("dragover", (event) => {
        // マウス位置から前後挿入を判定し、ガイド線クラスを付け替える。
        event.preventDefault();
        chipList.querySelectorAll(".drop-before, .drop-after").forEach((node) => {
          node.classList.remove("drop-before", "drop-after");
        });
        if (dragFilterViewId && dragFilterViewId !== favoriteOrderKey) {
          const rect = chip.getBoundingClientRect();
          const isBefore = event.clientX < rect.left + rect.width / 2;
          chip.classList.add(isBefore ? "drop-before" : "drop-after");
        }
      });
      chip.addEventListener("dragleave", () => {
        // この要素から離れたらガイド表示を消す。
        chip.classList.remove("drop-before", "drop-after");
      });
      chip.addEventListener("drop", async (event) => {
        // drop時に前後挿入判定を確定し、並び順を保存する。
        event.preventDefault();
        event.stopPropagation();
        const insertBefore = chip.classList.contains("drop-before");
        chip.classList.remove("drop-before", "drop-after");
        const sourceId = dragFilterViewId;
        const targetId = favoriteOrderKey;
        dragFilterViewId = "";
        try {
          await reorderFavoritesByDrop(context, favorites, sourceId, targetId, insertBefore);
        } catch {
          // 並べ替え失敗時は現状を維持する。
        } finally {
          scheduleInlineRender({ immediate: true });
        }
      });
      chipList.appendChild(chip);
    });

    if (consumedAddedFavoriteKey) {
      pendingAddedFavoriteKey = "";
    }

    root.appendChild(leadingFavorite);
    root.appendChild(chipList);

    {
      const quickAddButton = document.createElement("button");
      quickAddButton.type = "button";
      quickAddButton.className = "gsfv-quick-add";
      const canAddCurrent = !!context.currentSheetId && !isAlreadyFavorite;
      quickAddButton.disabled = !canAddCurrent;
      quickAddButton.setAttribute("aria-label", t("addCurrent"));

      const quickAddIcon = document.createElement("span");
      quickAddIcon.className = "gsfv-quick-add-icon";
      quickAddIcon.appendChild(createIconSvg("add"));
      quickAddIcon.setAttribute("aria-hidden", "true");

      quickAddButton.appendChild(quickAddIcon);
      quickAddButton.addEventListener("click", async (event) => {
        // 現在状態を新規お気に入りとして追加し、直後に再描画する。
        event.preventDefault();
        event.stopPropagation();
        if (!canAddCurrent) {
          return;
        }
        try {
          pendingAddedFavoriteKey = await toggleCurrentFavorite(context, false);
        } finally {
          scheduleInlineRender({ immediate: true });
        }
      });
      root.appendChild(quickAddButton);
    }

    lastRenderSignature = currentSignature;
  } finally {
    isRendering = false;
    if (hasPendingRender) {
      hasPendingRender = false;
      scheduleInlineRender({ immediate: true });
    }
  }
}

function scheduleInlineRender(options = {}) {
  // 即時実行と遅延集約を切り替え、無駄なDOM再構築を抑える。
  const { immediate = false, allowWhileMenuOpen = false } = options;

  // メニュー操作中の再描画は抑制し、短い遅延で描画を集約する。
  if (!allowWhileMenuOpen && document.getElementById(CHIP_MENU_ID)) {
    return;
  }

  if (immediate) {
    if (renderTimerId) {
      window.clearTimeout(renderTimerId);
      renderTimerId = 0;
    }
    void renderInlineFavorites();
    return;
  }

  if (renderTimerId) {
    return;
  }

  renderTimerId = window.setTimeout(() => {
    renderTimerId = 0;
    void renderInlineFavorites();
  }, 80);
}

const domObserver = new MutationObserver((mutations) => {
  // Sheets側DOMの変化を監視し、必要時だけ再描画を予約する。
  // 外部DOM変化のみ検知して再描画する（自前要素の変化は除外）。
  const inlineRoot = document.getElementById(INLINE_ROOT_ID);
  const inlineStyle = document.getElementById(INLINE_STYLE_LINK_ID);
  const inlineFavoriteToggle = document.getElementById(FAVORITE_TOGGLE_BUTTON_ID);

  const hasExternalMutation = mutations.some((mutation) => {
    const target = mutation.target;
    if (!(target instanceof Node)) {
      return true;
    }

    if (inlineRoot && (target === inlineRoot || inlineRoot.contains(target))) {
      return false;
    }
    if (inlineStyle && (target === inlineStyle || inlineStyle.contains(target))) {
      return false;
    }
    if (inlineFavoriteToggle && (target === inlineFavoriteToggle || inlineFavoriteToggle.contains(target))) {
      return false;
    }

    return true;
  });

  if (hasExternalMutation) {
    scheduleInlineRender();
  }
});

domObserver.observe(document.documentElement, {
  childList: true,
  subtree: true
});

observeUrlChanges();
window.addEventListener(URL_CHANGE_EVENT, () => {
  // URL変化に即追従する。
  scheduleInlineRender({ immediate: true });
});
window.addEventListener("popstate", () => {
  // 戻る/進む操作に追従して表示状態を同期する。
  scheduleInlineRender({ immediate: true });
});
chrome.storage.onChanged.addListener((_changes, areaName) => {
  // 他コンテキスト更新時もローカル変更を取り込む。
  if (areaName === "sync") {
    if (document.getElementById(CHIP_MENU_ID)) {
      return;
    }
    scheduleInlineRender({ immediate: true });
  }
});

scheduleInlineRender();
