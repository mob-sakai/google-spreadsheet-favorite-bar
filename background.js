const STORAGE_KEY = "favoritesBySpreadsheet";
const INLINE_VISIBILITY_KEY = "inlineVisibilityBySpreadsheet";

function t(key, substitutions) {
  // background でも chrome.i18n を翻訳ソースとして使用する。
  const message = substitutions === undefined
    ? chrome.i18n.getMessage(key)
    : chrome.i18n.getMessage(key, substitutions);
  return message || key;
}

const UNNAMED_FAVORITE_LABEL = t("unnamedFavoriteLabel");

function createErrorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSpreadsheetId(spreadsheetId) {
  // storageキーとして使うIDは空白を除去して正規化する。
  return isNonEmptyString(spreadsheetId) ? spreadsheetId.trim() : "";
}

function normalizeUrlTail(urlTail) {
  // ユーザー入力の先頭記号ゆれ（? / #）を吸収する。
  if (!isNonEmptyString(urlTail)) {
    return "";
  }
  const trimmed = urlTail.trim();
  if (trimmed.startsWith("?") || trimmed.startsWith("#")) {
    return trimmed;
  }
  return `?${trimmed}`;
}

function parseUrlTail(urlTail) {
  // query/hash 文字列から gid/fvid を抽出し、再利用しやすい形へ変換する。
  const normalized = normalizeUrlTail(urlTail);
  if (!normalized) {
    return {
      urlParams: "",
      sheetId: "",
      filterViewId: ""
    };
  }

  const hashIndex = normalized.indexOf("#");
  const searchText = normalized.startsWith("#")
    ? ""
    : (hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized);
  const hashText = hashIndex >= 0
    ? normalized.slice(hashIndex + 1)
    : (normalized.startsWith("#") ? normalized.slice(1) : "");

  const queryParams = new URLSearchParams(searchText.startsWith("?") ? searchText.slice(1) : searchText);
  const hashParams = new URLSearchParams(hashText);
  const safeSheetId = (queryParams.get("gid") || hashParams.get("gid") || "").trim();
  const safeFilterViewId = (queryParams.get("fvid") || hashParams.get("fvid") || "").trim();
  const safeUrlParams = `${searchText}${hashText ? `#${hashText}` : ""}`;

  return {
    urlParams: safeUrlParams,
    sheetId: safeSheetId,
    filterViewId: safeFilterViewId
  };
}

function buildUrlParamsFromIds(sheetId, filterViewId) {
  // 旧データ互換: ID情報だけある場合に urlParams 文字列を再構成する。
  const safeSheetId = isNonEmptyString(sheetId) ? sheetId.trim() : "";
  const safeFilterViewId = isNonEmptyString(filterViewId) ? filterViewId.trim() : "";
  if (!safeSheetId) {
    return "";
  }

  const queryParams = new URLSearchParams();
  queryParams.set("gid", safeSheetId);
  if (safeFilterViewId) {
    queryParams.set("fvid", safeFilterViewId);
  }

  if (!safeFilterViewId) {
    return `?${queryParams.toString()}`;
  }

  const hashParams = new URLSearchParams();
  hashParams.set("gid", safeSheetId);
  hashParams.set("fvid", safeFilterViewId);
  return `?${queryParams.toString()}#${hashParams.toString()}`;
}

function resolveFavoriteLocation(input) {
  // 新旧フォーマットを統合し、sheet/filter/urlParams を矛盾なく決定する。
  const parsed = parseUrlTail(input && input.urlParams);
  const fallbackSheetId = isNonEmptyString(input && input.sheetId) ? input.sheetId.trim() : "";
  const fallbackFilterViewId = isNonEmptyString(input && input.filterViewId) ? input.filterViewId.trim() : "";

  const sheetId = parsed.sheetId || fallbackSheetId;
  const filterViewId = parsed.filterViewId || fallbackFilterViewId;
  const urlParams = parsed.urlParams || buildUrlParamsFromIds(sheetId, filterViewId);

  return {
    sheetId,
    filterViewId,
    urlParams
  };
}

function buildFavoriteOrderKey(favorite) {
  // 並び替え順の保存に使う一意キー。
  const filterViewId = isNonEmptyString(favorite && favorite.filterViewId) ? favorite.filterViewId.trim() : "";
  const sheetId = isNonEmptyString(favorite && favorite.sheetId) ? favorite.sheetId.trim() : "";
  const createdAt = isNonEmptyString(favorite && favorite.createdAt) ? favorite.createdAt.trim() : "";
  return `f:${filterViewId}|s:${sheetId}|c:${createdAt}`;
}

async function getFavoritesMap() {
  // favoritesの生データをそのまま取得する。
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const value = result[STORAGE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

async function saveFavoritesMap(map) {
  // 保存前に不要項目を落として compact 形式へ揃える。
  const compact = {};
  Object.entries(map || {}).forEach(([spreadsheetId, items]) => {
    if (!Array.isArray(items)) {
      compact[spreadsheetId] = [];
      return;
    }

    compact[spreadsheetId] = items.map((item) => {
      const location = resolveFavoriteLocation(item || {});
      return {
        label: isNonEmptyString(item && item.label) ? item.label.trim() : UNNAMED_FAVORITE_LABEL,
        sheetId: location.sheetId,
        filterViewId: location.filterViewId,
        urlParams: location.urlParams,
        createdAt: isNonEmptyString(item && item.createdAt)
          ? item.createdAt
          : new Date().toISOString()
      };
    });
  });

  await chrome.storage.local.set({ [STORAGE_KEY]: compact });
}

async function getInlineVisibilityMap() {
  // インライン表示状態マップを取得する。
  const result = await chrome.storage.local.get([INLINE_VISIBILITY_KEY]);
  const value = result[INLINE_VISIBILITY_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

async function saveInlineVisibilityMap(map) {
  // インライン表示状態マップを保存する。
  await chrome.storage.local.set({ [INLINE_VISIBILITY_KEY]: map });
}

function buildApplyUrl(url, filterViewId, sheetId, urlParams) {
  // urlParams がある場合はそれを最優先し、無い場合はID情報からURLを構成する。
  const parsedUrl = new URL(url);

  const safeUrlTail = normalizeUrlTail(urlParams);
  if (safeUrlTail) {
    const hashIndex = safeUrlTail.indexOf("#");
    const searchText = safeUrlTail.startsWith("#")
      ? ""
      : (hashIndex >= 0 ? safeUrlTail.slice(0, hashIndex) : safeUrlTail);
    const hashText = hashIndex >= 0
      ? safeUrlTail.slice(hashIndex + 1)
      : (safeUrlTail.startsWith("#") ? safeUrlTail.slice(1) : "");
    parsedUrl.search = searchText;
    parsedUrl.hash = hashText ? `#${hashText}` : "";
    return parsedUrl.toString();
  }

  const hashText = parsedUrl.hash.startsWith("#")
    ? parsedUrl.hash.slice(1)
    : parsedUrl.hash;
  const hashParams = new URLSearchParams(hashText);

  parsedUrl.searchParams.delete("gid");
  parsedUrl.searchParams.delete("fvid");
  hashParams.delete("fvid");
  hashParams.delete("gid");

  const safeSheetId = sheetId.trim();
  parsedUrl.searchParams.set("gid", safeSheetId);

  if (isNonEmptyString(filterViewId)) {
    const safeFilterViewId = filterViewId.trim();
    hashParams.set("gid", safeSheetId);
    hashParams.set("fvid", safeFilterViewId);
  }

  const nextHash = hashParams.toString();
  parsedUrl.hash = nextHash ? `#${nextHash}` : "";

  return parsedUrl.toString();
}

async function getInlineVisibility(spreadsheetId) {
  // 未設定は false と同等で扱う。
  const safeSpreadsheetId = normalizeSpreadsheetId(spreadsheetId);
  if (!safeSpreadsheetId) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }

  const map = await getInlineVisibilityMap();
  return map[safeSpreadsheetId] === true;
}

async function setInlineVisibility(payload) {
  // スプレッドシート単位の表示フラグを更新する。
  const safeSpreadsheetId = normalizeSpreadsheetId(payload.spreadsheetId);
  if (!safeSpreadsheetId) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }
  if (typeof payload.visible !== "boolean") {
    throw createErrorWithCode("INVALID_VISIBILITY", t("invalidVisibility"));
  }

  const map = await getInlineVisibilityMap();
  map[safeSpreadsheetId] = payload.visible;
  await saveInlineVisibilityMap(map);
  return { spreadsheetId: safeSpreadsheetId, visible: payload.visible };
}

async function getFavorites(spreadsheetId) {
  // 取得時に新旧データ形式を正規化して返す。
  if (!isNonEmptyString(spreadsheetId)) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }

  const map = await getFavoritesMap();
  const items = map[spreadsheetId];
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => {
    const location = resolveFavoriteLocation(item || {});
    return {
      label: isNonEmptyString(item && item.label) ? item.label.trim() : UNNAMED_FAVORITE_LABEL,
      sheetId: location.sheetId,
      filterViewId: location.filterViewId,
      urlParams: location.urlParams,
      createdAt: isNonEmptyString(item && item.createdAt)
        ? item.createdAt
        : new Date().toISOString()
    };
  });
}

async function addFavorite(payload) {
  // 追加時に重複を検出し、ラベル未指定なら補完ラベルを付ける。
  const {
    spreadsheetId,
    spreadsheetTitle,
    filterViewId,
    label,
    sheetId,
    urlParams
  } = payload;
  if (!isNonEmptyString(spreadsheetId)) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }
  const location = resolveFavoriteLocation({
    sheetId,
    filterViewId,
    urlParams
  });
  const safeFilterViewId = location.filterViewId;
  const safeSheetId = location.sheetId;
  const safeUrlParams = location.urlParams;
  if (!safeSheetId) {
    throw createErrorWithCode("INVALID_SHEET_ID", t("invalidSheetId"));
  }

  const map = await getFavoritesMap();
  const current = Array.isArray(map[spreadsheetId]) ? map[spreadsheetId] : [];

  const exists = current.some((item) => {
    const itemFilterViewId = isNonEmptyString(item.filterViewId) ? item.filterViewId.trim() : "";
    const itemSheetId = isNonEmptyString(item.sheetId) ? item.sheetId.trim() : "";
    if (itemFilterViewId !== safeFilterViewId) {
      return false;
    }
    if (safeFilterViewId) {
      return true;
    }
    return itemSheetId === safeSheetId;
  });
  if (exists) {
    throw createErrorWithCode(
      "DUPLICATE_FAVORITE",
      t("duplicateError")
    );
  }

  const safeLabel = isNonEmptyString(label)
    ? label.trim()
    : safeFilterViewId
      ? `${spreadsheetTitle || "Spreadsheet"} (fvid:${safeFilterViewId})`
      : (spreadsheetTitle || UNNAMED_FAVORITE_LABEL);

  const favorite = {
    filterViewId: safeFilterViewId,
    label: safeLabel,
    sheetId: safeSheetId,
    urlParams: safeUrlParams,
    createdAt: new Date().toISOString()
  };

  map[spreadsheetId] = [...current, favorite];
  await saveFavoritesMap(map);

  return favorite;
}

async function deleteFavorite(payload) {
  // filterViewId が空の場合は sourceSheetId も使って削除対象を特定する。
  const { spreadsheetId, filterViewId, sourceSheetId } = payload;
  if (!isNonEmptyString(spreadsheetId)) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }

  const safeFilterViewId = isNonEmptyString(filterViewId) ? filterViewId.trim() : "";
  const safeSourceSheetId = isNonEmptyString(sourceSheetId) ? sourceSheetId.trim() : "";

  const map = await getFavoritesMap();
  const current = Array.isArray(map[spreadsheetId]) ? map[spreadsheetId] : [];
  const next = current.filter((item) => {
    const itemFilterViewId = isNonEmptyString(item.filterViewId) ? item.filterViewId.trim() : "";
    if (itemFilterViewId !== safeFilterViewId) {
      return true;
    }
    if (safeFilterViewId) {
      return false;
    }
    const itemSheetId = isNonEmptyString(item.sheetId) ? item.sheetId.trim() : "";
    if (safeSourceSheetId) {
      return itemSheetId !== safeSourceSheetId;
    }
    return false;
  });

  map[spreadsheetId] = next;
  await saveFavoritesMap(map);

  return { removed: current.length !== next.length };
}

async function updateFavoriteLabel(payload) {
  // ポップアップ編集用の軽量ラベル更新。
  const { spreadsheetId, filterViewId, label } = payload;
  if (!isNonEmptyString(spreadsheetId)) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }
  if (!isNonEmptyString(filterViewId)) {
    throw createErrorWithCode("INVALID_FILTER_VIEW_ID", t("invalidFilterViewId"));
  }
  if (!isNonEmptyString(label)) {
    throw createErrorWithCode("INVALID_LABEL", t("invalidLabel"));
  }

  const safeLabel = label.trim();
  const map = await getFavoritesMap();
  const current = Array.isArray(map[spreadsheetId]) ? map[spreadsheetId] : [];
  const index = current.findIndex((item) => item.filterViewId === filterViewId);
  if (index < 0) {
    throw createErrorWithCode("FAVORITE_NOT_FOUND", t("favoriteNotFound"));
  }

  const next = [...current];
  next[index] = { ...next[index], label: safeLabel };
  map[spreadsheetId] = next;
  await saveFavoritesMap(map);
  return next[index];
}

async function updateFavoriteDetails(payload) {
  // content右クリックメニュー用の詳細更新（名前・ID・urlParams）。
  const {
    spreadsheetId,
    filterViewId,
    sourceSheetId,
    label,
    sheetId,
    nextFilterViewId,
    nextUrlParams
  } = payload;
  if (!isNonEmptyString(spreadsheetId)) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }
  const safeLabel = isNonEmptyString(label) ? label.trim() : UNNAMED_FAVORITE_LABEL;
  const safeFilterViewId = isNonEmptyString(filterViewId) ? filterViewId.trim() : "";
  const safeSourceSheetId = isNonEmptyString(sourceSheetId) ? sourceSheetId.trim() : "";
  const location = resolveFavoriteLocation({
    sheetId,
    filterViewId: nextFilterViewId,
    urlParams: nextUrlParams
  });
  const safeSheetId = location.sheetId;
  const safeNextFilterViewId = location.filterViewId;
  const safeNextUrlParams = location.urlParams;
  if (!safeSheetId) {
    throw createErrorWithCode("INVALID_SHEET_ID", t("invalidSheetId"));
  }
  const map = await getFavoritesMap();
  const current = Array.isArray(map[spreadsheetId]) ? map[spreadsheetId] : [];

  const index = current.findIndex((item) => {
    const itemFilterViewId = isNonEmptyString(item.filterViewId) ? item.filterViewId.trim() : "";
    if (itemFilterViewId !== safeFilterViewId) {
      return false;
    }
    if (safeFilterViewId) {
      return true;
    }
    const itemSheetId = isNonEmptyString(item.sheetId) ? item.sheetId.trim() : "";
    if (safeSourceSheetId) {
      return itemSheetId === safeSourceSheetId;
    }
    return true;
  });
  if (index < 0) {
    throw createErrorWithCode("FAVORITE_NOT_FOUND", t("favoriteNotFound"));
  }

  const next = [...current];
  next[index] = {
    ...next[index],
    label: safeLabel,
    sheetId: safeSheetId,
    filterViewId: safeNextFilterViewId,
    urlParams: safeNextUrlParams
  };
  map[spreadsheetId] = next;
  await saveFavoritesMap(map);
  return next[index];
}

async function reorderFavorites(payload) {
  // 新形式の orderedFavoriteKeys を優先し、旧形式にも後方互換で対応する。
  const { spreadsheetId, orderedFilterViewIds, orderedFavoriteKeys } = payload;
  if (!isNonEmptyString(spreadsheetId)) {
    throw createErrorWithCode("INVALID_SPREADSHEET_ID", t("invalidSpreadsheetId"));
  }
  if (!Array.isArray(orderedFilterViewIds) && !Array.isArray(orderedFavoriteKeys)) {
    throw createErrorWithCode("INVALID_ORDER", t("invalidOrder"));
  }

  const map = await getFavoritesMap();
  const current = Array.isArray(map[spreadsheetId]) ? map[spreadsheetId] : [];

  if (Array.isArray(orderedFavoriteKeys)) {
    const byKey = new Map(current.map((item) => [buildFavoriteOrderKey(item), item]));
    const used = new Set();
    const next = [];

    orderedFavoriteKeys.forEach((key) => {
      if (isNonEmptyString(key) && byKey.has(key) && !used.has(key)) {
        next.push(byKey.get(key));
        used.add(key);
      }
    });

    current.forEach((item) => {
      const key = buildFavoriteOrderKey(item);
      if (!used.has(key)) {
        next.push(item);
      }
    });

    map[spreadsheetId] = next;
    await saveFavoritesMap(map);
    return next;
  }

  const byId = new Map(current.map((item) => [item.filterViewId, item]));
  const used = new Set();
  const next = [];

  orderedFilterViewIds.forEach((id) => {
    if (isNonEmptyString(id) && byId.has(id) && !used.has(id)) {
      next.push(byId.get(id));
      used.add(id);
    }
  });

  current.forEach((item) => {
    if (!used.has(item.filterViewId)) {
      next.push(item);
    }
  });

  map[spreadsheetId] = next;
  await saveFavoritesMap(map);
  return next;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // すべてのメッセージをここで受け、成功/失敗レスポンス形式を統一する。
  const request = message || {};

  (async () => {
    switch (request.type) {
      case "GET_FAVORITES":
        return await getFavorites(request.spreadsheetId);
      case "ADD_FAVORITE":
        return await addFavorite(request);
      case "DELETE_FAVORITE":
        return await deleteFavorite(request);
      case "UPDATE_FAVORITE_LABEL":
        return await updateFavoriteLabel(request);
      case "UPDATE_FAVORITE_DETAILS":
        return await updateFavoriteDetails(request);
      case "REORDER_FAVORITES":
        return await reorderFavorites(request);
      case "BUILD_APPLY_URL":
        if (!isNonEmptyString(request.url)) {
          throw createErrorWithCode("INVALID_URL", t("invalidUrl"));
        }
        return { url: buildApplyUrl(request.url, request.filterViewId, request.sheetId, request.urlParams) };
      case "GET_INLINE_VISIBILITY":
        return { visible: await getInlineVisibility(request.spreadsheetId) };
      case "SET_INLINE_VISIBILITY":
        return await setInlineVisibility(request);
      default:
        throw createErrorWithCode("UNSUPPORTED_MESSAGE", t("unsupportedMessage"));
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : t("unknownBackgroundError");
      const errorCode = error && typeof error.code === "string" ? error.code : "UNKNOWN_ERROR";
      sendResponse({ ok: false, error: errorMessage, code: errorCode });
    });

  return true;
});
