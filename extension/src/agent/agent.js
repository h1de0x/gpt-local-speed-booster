/*
 * GPT Local Speed Booster
 * Copyright (c) 2026 H1de0x
 * SPDX-License-Identifier: MIT
 */
(() => {
  "use strict";

  const PAGE_SOURCE = "gpt-local-speed-booster:page";
  const AGENT_SOURCE = "gpt-local-speed-booster:agent";

  const SETTINGS_KEY = "gpt_local_speed_booster_settings";
  const SESSION_KEY = "gpt_local_speed_booster_sessions";
  const STATS_KEY = "gpt_local_speed_booster_last_stats";

  const EXTRA_MESSAGES_KEY = "gpt_local_speed_booster_extra_messages";
  const NAVIGATING_KEY = "gpt_local_speed_booster_navigating";
  const NAV_ACK_KEY = "gpt_local_speed_booster_nav_ack";
  const SCROLL_RESTORE_KEY = "gpt_local_speed_booster_scroll_restore";
  const NEXT_BODY_CACHE_KEY = "gpt_local_speed_booster_next_body_cache_v1";
  const NEXT_BODY_CACHE_PREFIX = "gpt_local_speed_booster_next_body_cache_v2:";
  const NEXT_BODY_CACHE_INDEX_KEY = "gpt_local_speed_booster_next_body_cache_v2:index";

  const DEFAULT_SETTINGS = {
    enabled: true,
    visibleLimit: 40,
    showBadge: true,
    showLoadMore: true
  };

  const extensionApi = typeof browser !== "undefined" ? browser : chrome;
  const usingPromiseApi = typeof browser !== "undefined";

  let currentSettings = { ...DEFAULT_SETTINGS };
  let currentSession = {
    extraMessages: 0,
    pendingScrollRestore: null,
    navigating: false
  };
  let activePageKey = pageKey();
  let lastStatus = null;
  let restoreAttempted = false;
  let loadMoreRetryTimer = null;

  init();

  async function init() {
    currentSettings = await loadSettings();
    currentSession = await loadCurrentSession();

    sendConfigToPage({
      ...currentSettings,
      extraMessages: currentSession.extraMessages
    });

    window.postMessage({ source: AGENT_SOURCE, type: "status:request" }, "*");

    window.addEventListener("message", handlePageMessage);
    extensionApi.runtime.onMessage.addListener(handleRuntimeMessage);

    setupScrollRestoreWatcher();
    setupRouteWatcher();
  }

  function setupRouteWatcher() {
    setInterval(async () => {
      const nextPageKey = pageKey();

      if (nextPageKey === activePageKey) return;

      activePageKey = nextPageKey;
      restoreAttempted = false;
      lastStatus = null;
      currentSession = await loadCurrentSession();

      sendConfigToPage({
        ...currentSettings,
        extraMessages: currentSession.extraMessages
      });

      window.postMessage({ source: AGENT_SOURCE, type: "status:request" }, "*");
      renderPageControls();
      setupScrollRestoreWatcher();
    }, 500);
  }

  function storageGet(defaults) {
    if (usingPromiseApi) return extensionApi.storage.local.get(defaults);

    return new Promise((resolve) => {
      extensionApi.storage.local.get(defaults, resolve);
    });
  }

  function storageSet(values) {
    if (usingPromiseApi) return extensionApi.storage.local.set(values);

    return new Promise((resolve) => {
      extensionApi.storage.local.set(values, resolve);
    });
  }

  async function loadSettings() {
    const data = await storageGet({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    return normalizeSettings(data[SETTINGS_KEY]);
  }

  async function saveSettings(settings) {
    const previousVisibleLimit = currentSettings.visibleLimit;
    currentSettings = normalizeSettings(settings);
    const visibleLimitChanged = currentSettings.visibleLimit !== previousVisibleLimit;

    await storageSet({ [SETTINGS_KEY]: currentSettings });

    if (visibleLimitChanged) {
      clearCurrentPageLoadState();
      lastStatus = null;
      await saveCurrentSession({
        extraMessages: 0,
        pendingScrollRestore: null,
        navigating: false
      });
    }

    sendConfigToPage({
      ...currentSettings,
      extraMessages: visibleLimitChanged ? 0 : currentSession.extraMessages
    });

    renderPageControls();

    return {
      settings: currentSettings,
      visibleLimitChanged
    };
  }

  function normalizeSettings(settings) {
    const input = settings || {};

    return {
      enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SETTINGS.enabled,
      visibleLimit: clampInteger(input.visibleLimit, 1, 200, DEFAULT_SETTINGS.visibleLimit),
      showBadge: typeof input.showBadge === "boolean" ? input.showBadge : DEFAULT_SETTINGS.showBadge,
      showLoadMore: typeof input.showLoadMore === "boolean" ? input.showLoadMore : DEFAULT_SETTINGS.showLoadMore
    };
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;

    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function pageKey() {
    const url = new URL(window.location.href);
    return `${url.origin}${url.pathname}`;
  }

  function isConversationPage() {
    return /^\/c\/[^/]+/.test(window.location.pathname);
  }

  function pageKeyFromUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  }

  function displayStatus() {
    if (!lastStatus || !isConversationPage()) return null;

    if (lastStatus.url && pageKeyFromUrl(lastStatus.url) !== pageKey()) {
      return null;
    }

    return lastStatus;
  }

  async function loadAllSessions() {
    const data = await storageGet({ [SESSION_KEY]: {} });
    return data[SESSION_KEY] && typeof data[SESSION_KEY] === "object"
      ? data[SESSION_KEY]
      : {};
  }

  async function loadCurrentSession() {
    const sessions = await loadAllSessions();
    const stored = sessions[pageKey()] || {};
    const fastExtra = readFastExtraMessages();
    const fastScroll = readFastScrollRestore();

    return {
      extraMessages: Math.max(clampInteger(stored.extraMessages, 0, 5000, 0), fastExtra),
      pendingScrollRestore: fastScroll || stored.pendingScrollRestore || null,
      navigating: sessionStorage.getItem(NAVIGATING_KEY) === "true" || stored.navigating === true
    };
  }

  function readFastExtraMessages() {
    try {
      const raw = localStorage.getItem(EXTRA_MESSAGES_KEY);
      if (!raw) return 0;

      const stored = JSON.parse(raw);
      if (!stored) return 0;

      const storedPageKey = stored.pageKey || "";
      const storedUrl = stored.url || "";

      if (storedPageKey) {
        if (storedPageKey !== pageKey()) return 0;
      } else if (storedUrl !== window.location.href) {
        return 0;
      }

      return clampInteger(stored.extra, 0, 5000, 0);
    } catch {
      return 0;
    }
  }

  function writeFastExtraMessages(extraMessages) {
    try {
      localStorage.setItem(EXTRA_MESSAGES_KEY, JSON.stringify({
        url: window.location.href,
        pageKey: pageKey(),
        extra: extraMessages,
        updatedAt: Date.now()
      }));
    } catch {
      // Non-critical.
    }
  }

  function clearCurrentPageLoadState() {
    try {
      localStorage.removeItem(EXTRA_MESSAGES_KEY);
    } catch {
      // Non-critical.
    }

    try {
      sessionStorage.removeItem(NEXT_BODY_CACHE_KEY);
    } catch {
      // Non-critical.
    }

    try {
      const rawIndex = sessionStorage.getItem(NEXT_BODY_CACHE_INDEX_KEY);
      const index = rawIndex ? JSON.parse(rawIndex) : [];

      if (Array.isArray(index)) {
        for (const item of index) {
          if (item?.key) sessionStorage.removeItem(item.key);
        }
      }

      sessionStorage.removeItem(NEXT_BODY_CACHE_INDEX_KEY);

      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key && key.startsWith(NEXT_BODY_CACHE_PREFIX)) {
          sessionStorage.removeItem(key);
        }
      }
    } catch {
      // Non-critical.
    }

    clearFastNavigationState();
  }

  function clearFastNavigationState() {
    try {
      sessionStorage.removeItem(NAVIGATING_KEY);
      sessionStorage.removeItem(NAV_ACK_KEY);
      sessionStorage.removeItem(SCROLL_RESTORE_KEY);
    } catch {
      // Non-critical.
    }
  }

  function writeFastScrollRestore(anchor) {
    try {
      sessionStorage.setItem(SCROLL_RESTORE_KEY, JSON.stringify(anchor || null));
      sessionStorage.setItem(NAVIGATING_KEY, "true");
      sessionStorage.removeItem(NAV_ACK_KEY);
    } catch {
      // Non-critical.
    }
  }

  function readFastScrollRestore() {
    try {
      const raw = sessionStorage.getItem(SCROLL_RESTORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function saveCurrentSession(patch = {}) {
    const sessions = await loadAllSessions();

    currentSession = {
      ...currentSession,
      ...patch
    };

    sessions[pageKey()] = {
      ...currentSession,
      updatedAt: Date.now()
    };

    await storageSet({ [SESSION_KEY]: sessions });
  }

  async function clearPendingScrollRestore() {
    if (!currentSession.pendingScrollRestore && !currentSession.navigating) return;
    clearFastNavigationState();
    await saveCurrentSession({ pendingScrollRestore: null, navigating: false });
  }

  function sendConfigToPage(settings) {
    window.postMessage({
      source: AGENT_SOURCE,
      type: "config:update",
      payload: {
        ...settings,
        pageKey: pageKey()
      }
    }, "*");
  }

  function handlePageMessage(event) {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || message.source !== PAGE_SOURCE) return;

    if (message.type === "status") {
      lastStatus = message.payload || null;
      persistStats(lastStatus);
      renderPageControls();
      setupScrollRestoreWatcher();
    }

    if (message.type === "ready") {
      sendConfigToPage({
        ...currentSettings,
        extraMessages: currentSession.extraMessages
      });
    }
  }

  async function persistStats(status) {
    if (!status) return;

    try {
      await storageSet({
        [STATS_KEY]: {
          ...status,
          savedAt: Date.now(),
          url: window.location.href
        }
      });
    } catch {
      // Non-critical.
    }
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    if (!message || message.target !== "gpt-local-speed-booster:agent") return false;

    (async () => {
      if (message.type === "get-state") {
        sendResponse({
          ok: true,
          settings: currentSettings,
          session: currentSession,
          status: lastStatus
        });
        return;
      }

      if (message.type === "update-settings") {
        const result = await saveSettings({
          ...currentSettings,
          ...(message.payload || {})
        });

        sendResponse({
          ok: true,
          settings: result.settings,
          session: currentSession,
          status: lastStatus,
          visibleLimitChanged: result.visibleLimitChanged,
          reloadScheduled: result.visibleLimitChanged
        });

        if (result.visibleLimitChanged) {
          setTimeout(() => {
            window.location.reload();
          }, 50);
        }

        return;
      }

      if (message.type === "reload-page") {
        await prepareReload();
        window.location.reload();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "reset-extra") {
        clearCurrentPageLoadState();
        lastStatus = null;
        await saveCurrentSession({ extraMessages: 0, pendingScrollRestore: null, navigating: false });
        sendConfigToPage({
          ...currentSettings,
          extraMessages: 0
        });
        renderPageControls();
        sendResponse({ ok: true, session: currentSession, status: lastStatus });
        return;
      }

      if (message.type === "reset-extra-and-reload") {
        clearCurrentPageLoadState();
        lastStatus = null;
        await saveCurrentSession({ extraMessages: 0, pendingScrollRestore: null, navigating: false });
        sendConfigToPage({
          ...currentSettings,
          extraMessages: 0
        });
        sendResponse({ ok: true, session: currentSession, status: lastStatus });
        window.location.reload();
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    })().catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });

    return true;
  }

  function renderPageControls() {
    renderBadge();
    renderLoadMoreButton();
  }

  function renderBadge() {
    const existing = document.getElementById("gpt-local-speed-booster-badge");

    if (!currentSettings.showBadge) {
      existing?.remove();
      return;
    }

    let badge = existing;

    if (!badge) {
      badge = document.createElement("div");
      badge.id = "gpt-local-speed-booster-badge";
      document.documentElement.appendChild(badge);
    }

    if (!currentSettings.enabled) {
      badge.textContent = "Booster off";
      badge.dataset.state = "off";
      return;
    }

    const status = displayStatus();

    if (!status || !status.totalVisibleMessages) {
      badge.textContent = "Booster ready";
      badge.dataset.state = "idle";
      return;
    }

    const total = Number(status.totalVisibleMessages || 0);
    const shown = Number(status.keptVisibleMessages || total || 0);
    const isActuallyTrimmed = Boolean(status.changed) && shown > 0 && total > shown;

    // Short/new chats can legitimately report 3/3, 5/5, etc. That is not
    // useful as a badge state, and it looks like stale data. Only show the
    // counter when the booster really hid older messages.
    if (!isActuallyTrimmed) {
      badge.textContent = "Booster ready";
      badge.dataset.state = "idle";
      return;
    }

    badge.textContent = `Booster ${shown}/${total}`;
    badge.dataset.state = "active";
  }

  function renderLoadMoreButton() {
    clearTimeout(loadMoreRetryTimer);

    const existing = document.getElementById("gpt-local-speed-booster-load-more");
    const status = displayStatus();

    if (!currentSettings.enabled || !currentSettings.showLoadMore || !status?.hasOlderMessages) {
      existing?.remove();
      return;
    }

    const container = findMessagesContainer();

    if (!container) {
      loadMoreRetryTimer = setTimeout(renderLoadMoreButton, 500);
      return;
    }

    let wrapper = existing;

    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.id = "gpt-local-speed-booster-load-more";
      wrapper.setAttribute("data-gpt-local-speed-booster", "load-more");

      const button = document.createElement("button");
      button.type = "button";
      button.addEventListener("click", handleLoadMoreClick);

      wrapper.appendChild(button);
    }

    const firstChild = container.firstElementChild;
    if (wrapper.parentElement !== container || firstChild !== wrapper) {
      container.insertBefore(wrapper, container.firstChild);
    }

    const button = wrapper.querySelector("button");
    const increment = getLoadIncrement();

    button.innerHTML = `
      <span class="gpt-local-speed-booster-load-title">Load ${increment} previous messages</span>
      <span class="gpt-local-speed-booster-load-subtitle">Reloads softly and restores your position</span>
    `;
    button.title = `Reload and keep ${increment} more previous messages`;
    button.disabled = false;
  }

  function getLoadIncrement() {
    const status = displayStatus();
    const total = status?.totalVisibleMessages || 0;
    const kept = status?.keptVisibleMessages || 0;
    const remaining = Math.max(0, total - kept);
    return remaining > 0 ? Math.min(currentSettings.visibleLimit, remaining) : currentSettings.visibleLimit;
  }

  async function handleLoadMoreClick(event) {
    event?.preventDefault();
    event?.stopPropagation();

    const wrapper = document.getElementById("gpt-local-speed-booster-load-more");
    const button = wrapper?.querySelector("button");

    if (button) {
      button.disabled = true;
      button.textContent = "Loading previous messages…";
    }

    const increment = getLoadIncrement();
    const nextExtraMessages = (currentSession.extraMessages || 0) + increment;
    const anchor = captureScrollAnchor();

    writeFastExtraMessages(nextExtraMessages);
    writeFastScrollRestore(anchor);

    await saveCurrentSession({
      extraMessages: nextExtraMessages,
      pendingScrollRestore: anchor,
      navigating: true
    });

    sendConfigToPage({
      ...currentSettings,
      extraMessages: nextExtraMessages
    });

    window.location.reload();
  }

  async function prepareReload() {
    const anchor = captureScrollAnchor();
    writeFastScrollRestore(anchor);

    await saveCurrentSession({
      pendingScrollRestore: anchor,
      navigating: true
    });
  }

  function findMessagesContainer() {
    const selectors = [
      '[data-testid^="conversation-turn-"]',
      "[data-message-author-role]",
      "article"
    ];

    for (const selector of selectors) {
      const firstTurn = document.querySelector(selector);
      if (!firstTurn) continue;

      let element = firstTurn.parentElement;

      while (element && element !== document.body && element.children.length < 2) {
        element = element.parentElement;
      }

      if (element && element !== document.body) {
        return element;
      }
    }

    return null;
  }

  function scrollContainer() {
    const candidates = [
      document.querySelector('main div[class*="overflow-y-auto"]'),
      document.querySelector('div[class*="react-scroll-to-bottom"]'),
      document.scrollingElement,
      document.documentElement
    ];

    for (const candidate of candidates) {
      if (!(candidate instanceof Element)) continue;

      const style = getComputedStyle(candidate);
      if (
        candidate === document.scrollingElement ||
        style.overflowY === "auto" ||
        style.overflowY === "scroll"
      ) {
        return candidate;
      }
    }

    return document.scrollingElement || document.documentElement;
  }

  function turnElements() {
    const selectors = [
      '[data-testid^="conversation-turn-"]',
      "[data-message-author-role]",
      "article"
    ];

    const seen = new Set();
    const result = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        if (seen.has(element)) continue;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        seen.add(element);
        result.push(element);
      }
    }

    return result;
  }

  function captureScrollAnchor() {
    const turns = turnElements();

    let best = null;
    let bestDistance = Infinity;

    for (const element of turns) {
      const rect = element.getBoundingClientRect();

      if (rect.bottom < 40 || rect.top > window.innerHeight - 40) continue;

      const distance = Math.abs(rect.top - 80);
      if (distance < bestDistance) {
        best = { element, rect };
        bestDistance = distance;
      }
    }

    if (!best && turns.length) {
      const element = turns[0];
      best = { element, rect: element.getBoundingClientRect() };
    }

    if (!best) {
      return {
        kind: "absolute",
        scrollTop: getScrollTop(),
        offsetTop: 0,
        textFingerprint: "",
        savedAt: Date.now()
      };
    }

    const element = best.element;
    const stableId =
      element.getAttribute("data-turn-id") ||
      element.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      "";

    return {
      kind: stableId ? "element" : "text",
      stableId,
      testId: element.getAttribute("data-testid") || "",
      role: element.getAttribute("data-message-author-role") || "",
      textFingerprint: textFingerprint(element),
      offsetTop: best.rect.top,
      scrollTop: getScrollTop(),
      savedAt: Date.now(),
      restoreMode: "load-more"
    };
  }

  function getScrollTop() {
    const scroller = scrollContainer();
    return "scrollTop" in scroller ? scroller.scrollTop : window.scrollY;
  }

  function setScrollTop(value) {
    const scroller = scrollContainer();

    if ("scrollTop" in scroller) {
      scroller.scrollTop = value;
      return;
    }

    window.scrollTo({ top: value, left: 0, behavior: "instant" });
  }

  function textFingerprint(element) {
    const text = (element.innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, 220);
  }

  function setupScrollRestoreWatcher() {
    if (restoreAttempted || !currentSession.pendingScrollRestore) return;

    restoreAttempted = true;

    const anchor = currentSession.pendingScrollRestore;
    let observer = null;
    let attempts = 0;
    let successStreak = 0;
    const startedAt = Date.now();
    const maxAttempts = 48;
    const minHoldMs = anchor.restoreMode === "load-more" ? 1800 : 1200;
    const requiredSuccesses = anchor.restoreMode === "load-more" ? 4 : 2;

    const attempt = async () => {
      attempts += 1;

      const restored = tryRestoreScroll(anchor);

      if (restored) {
        successStreak += 1;
      } else {
        successStreak = 0;
      }

      const heldLongEnough = Date.now() - startedAt >= minHoldMs;
      const stableEnough = successStreak >= requiredSuccesses && heldLongEnough;

      if (stableEnough || attempts >= maxAttempts) {
        observer?.disconnect();
        await clearPendingScrollRestore();
        return true;
      }

      return false;
    };

    const scheduleAttempt = (delay) => {
      setTimeout(() => {
        attempt().catch(() => {
          // Non-critical.
        });
      }, delay);
    };

    scheduleAttempt(80);
    scheduleAttempt(250);
    scheduleAttempt(600);
    scheduleAttempt(1200);
    scheduleAttempt(1800);
    scheduleAttempt(2400);

    observer = new MutationObserver(() => {
      const count = turnElements().length;
      if (count >= 3) {
        scheduleAttempt(120);
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    const interval = setInterval(async () => {
      const done = await attempt();
      if (done) clearInterval(interval);
    }, 250);

    setTimeout(async () => {
      clearInterval(interval);
      observer?.disconnect();
      await attempt();
    }, 3500);
  }

  function tryRestoreScroll(anchor) {
    if (!anchor) return true;

    const target = findAnchorElement(anchor);

    if (target instanceof HTMLElement) {
      const desiredOffset = Number(anchor.offsetTop) || 0;
      const rectBefore = target.getBoundingClientRect();

      target.scrollIntoView({ block: "start", behavior: "instant" });

      const rectAfter = target.getBoundingClientRect();
      const correction = rectAfter.top - desiredOffset;
      const scroller = scrollContainer();

      if (Math.abs(correction) > 1) {
        if ("scrollTop" in scroller) {
          scroller.scrollTop += correction;
        } else {
          window.scrollBy({ top: correction, left: 0, behavior: "instant" });
        }
      }

      const finalTop = target.getBoundingClientRect().top;
      const closeEnough = Math.abs(finalTop - desiredOffset) < 6;

      console.info("[GPT Local Speed Booster] scroll restore", {
        mode: anchor.restoreMode || "default",
        found: true,
        beforeTop: Math.round(rectBefore.top),
        finalTop: Math.round(finalTop),
        desiredOffset: Math.round(desiredOffset),
        closeEnough
      });

      return closeEnough;
    }

    // Absolute fallback is intentionally not considered final immediately.
    // ChatGPT can still auto-scroll after initial render, so keep retrying for
    // the stabilization window.
    if (typeof anchor.scrollTop === "number") {
      setScrollTop(anchor.scrollTop);
      return Date.now() - (anchor.savedAt || 0) > 2200;
    }

    return false;
  }

  function findAnchorElement(anchor) {
    if (!anchor) return null;

    if (anchor.stableId) {
      const selectors = [
        `[data-turn-id="${cssEscape(anchor.stableId)}"]`,
        `[data-message-id="${cssEscape(anchor.stableId)}"]`
      ];

      for (const selector of selectors) {
        const found = document.querySelector(selector);
        if (found) {
          return found.closest('[data-testid^="conversation-turn-"]') || found;
        }
      }
    }

    if (anchor.textFingerprint) {
      const fingerprint = anchor.textFingerprint;
      const candidates = turnElements()
        .map((element) => ({ element, text: textFingerprint(element) }))
        .filter((item) => item.text);

      const exact = candidates.find((item) => item.text === fingerprint);
      if (exact) return exact.element;

      const fuzzy = candidates.find((item) => (
        item.text.includes(fingerprint) ||
        fingerprint.includes(item.text.slice(0, 160))
      ));

      if (fuzzy) return fuzzy.element;
    }

    // Weak last-resort fallback. data-testid can shift after older messages are
    // loaded, so only use it when no text fingerprint is available.
    if (anchor.testId && !anchor.textFingerprint) {
      const found = document.querySelector(`[data-testid="${cssEscape(anchor.testId)}"]`);
      if (found) return found;
    }

    return null;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
