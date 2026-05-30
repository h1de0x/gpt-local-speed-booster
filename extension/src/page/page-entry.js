/*
 * GPT Local Speed Booster
 * Copyright (c) 2026 H1de0x
 * SPDX-License-Identifier: MIT
 */
(() => {
  "use strict";

  if (window.__GPT_LOCAL_SPEED_BOOSTER_PAGE_ENTRY__) return;
  window.__GPT_LOCAL_SPEED_BOOSTER_PAGE_ENTRY__ = true;

  const PAGE_SOURCE = "gpt-local-speed-booster:page";
  const AGENT_SOURCE = "gpt-local-speed-booster:agent";

  const EXTRA_MESSAGES_KEY = "gpt_local_speed_booster_extra_messages";
  const NAVIGATING_KEY = "gpt_local_speed_booster_navigating";
  const NAV_ACK_KEY = "gpt_local_speed_booster_nav_ack";
  const NEXT_BODY_CACHE_KEY = "gpt_local_speed_booster_next_body_cache_v1";
  const NEXT_BODY_CACHE_PREFIX = "gpt_local_speed_booster_next_body_cache_v2:";
  const NEXT_BODY_CACHE_INDEX_KEY = "gpt_local_speed_booster_next_body_cache_v2:index";
  const MAX_CACHED_BODY_CHARS = 4_000_000;
  const MAX_TOTAL_CACHED_BODY_CHARS = 4_500_000;
  const MAX_CACHE_AHEAD_STEPS = 5;

  const FULL_BODY_CACHE_DB_NAME = "gpt_local_speed_booster_full_body_cache";
  const FULL_BODY_CACHE_STORE = "conversationBodies";
  const FULL_BODY_CACHE_TTL_MS = 10 * 60 * 1000;
  const MAX_FULL_BODY_CACHE_CHARS = 30_000_000;
  const MAX_FULL_BODY_CACHE_ENTRIES = 3;

  let fullBodyCacheDbPromise = null;

  const state = {
    enabled: true,
    visibleLimit: 40,
    extraMessages: readStoredExtraMessages(),
    lastStatus: null
  };

  const originalFetch = window.fetch;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || message.source !== AGENT_SOURCE) return;

    if (message.type === "config:update") {
      applyConfig(message.payload || {});
    }

    if (message.type === "extra:set") {
      state.extraMessages = Math.max(0, Number(message.payload?.extraMessages) || 0);
    }

    if (message.type === "status:request") {
      const status = statusBelongsToCurrentPage(state.lastStatus)
        ? state.lastStatus
        : null;

      postStatus(status || emptyStatus());
    }
  });

  function readStoredExtraMessages() {
    try {
      if (sessionStorage.getItem(NAVIGATING_KEY) !== "true") return 0;

      const raw = localStorage.getItem(EXTRA_MESSAGES_KEY);
      if (!raw) return 0;

      const stored = JSON.parse(raw);
      if (!stored) return 0;

      const storedPageKey = stored.pageKey || "";
      const storedUrl = stored.url || "";

      if (storedPageKey) {
        if (storedPageKey !== currentPageKey()) return 0;
      } else if (storedUrl !== window.location.href) {
        return 0;
      }

      return clampInteger(stored.extra, 0, 5000, 0);
    } catch {
      return 0;
    }
  }

  function acknowledgeNavigation() {
    try {
      if (sessionStorage.getItem(NAVIGATING_KEY) === "true") {
        sessionStorage.setItem(NAV_ACK_KEY, "true");
      }
    } catch {
      // Non-critical.
    }
  }

  function currentPageKey() {
    const url = new URL(window.location.href);
    return `${url.origin}${url.pathname}`;
  }

  function pageKeyFromUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  }

  function statusBelongsToCurrentPage(status) {
    if (!status || !status.url) return false;
    return pageKeyFromUrl(status.url) === currentPageKey();
  }

  function emptyStatus() {
    return {
      enabled: state.enabled,
      totalVisibleMessages: 0,
      keptVisibleMessages: 0,
      hasOlderMessages: false,
      changed: false
    };
  }

  function applyConfig(config) {
    if (typeof config.enabled === "boolean") {
      state.enabled = config.enabled;
    }

    if (config.visibleLimit != null) {
      state.visibleLimit = clampInteger(config.visibleLimit, 1, 200, 40);
    }

    if (config.extraMessages != null) {
      const storedExtraMessages = readStoredExtraMessages();
      const configPageKey = config.pageKey || "";
      const configMatchesCurrentPage = !configPageKey || configPageKey === currentPageKey();
      const configExtraMessages = configMatchesCurrentPage
        ? clampInteger(config.extraMessages, 0, 5000, 0)
        : 0;

      // Use the larger current-chat value, but never accept extraMessages from
      // a different SPA route. This fixes both: Load more not applying, and
      // 80-message budgets leaking into other chats.
      state.extraMessages = Math.max(storedExtraMessages, configExtraMessages);
    }
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;

    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function isConversationRequest(url, method) {
    return method === "GET" &&
      url.includes("/backend-api/conversation") &&
      !url.includes("/backend-api/conversations");
  }

  function cloneHeadersWithoutBodyMetadata(headers) {
    const patched = new Headers(headers);
    patched.delete("content-length");
    patched.delete("content-encoding");
    return patched;
  }

  function rebuildOriginalResponse(response, bodyText) {
    const rebuilt = new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: cloneHeadersWithoutBodyMetadata(response.headers)
    });

    try {
      Object.defineProperty(rebuilt, "url", {
        value: response.url,
        configurable: true
      });
    } catch {
      // Non-critical.
    }

    return rebuilt;
  }

  function patchJsonHeaders(headers) {
    const patched = new Headers(headers);

    patched.set("content-type", "application/json; charset=utf-8");
    patched.delete("content-length");
    patched.delete("content-encoding");

    return patched;
  }

  function makeResponseFromBody(body, responseUrl, headers = null) {
    const rebuilt = new Response(body, {
      status: 200,
      statusText: "OK",
      headers: headers || {
        "content-type": "application/json; charset=utf-8"
      }
    });

    try {
      Object.defineProperty(rebuilt, "url", {
        value: responseUrl,
        configurable: true
      });
    } catch {
      // Non-critical.
    }

    return rebuilt;
  }

  function smallHash(value) {
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(36);
  }

  function makeCacheKey(requestUrl, extraMessages) {
    return `${NEXT_BODY_CACHE_PREFIX}${smallHash(currentPageKey())}:${smallHash(requestUrl)}:${state.visibleLimit}:${extraMessages}`;
  }

  function makeFullBodyCacheKey(requestUrl) {
    return `${smallHash(currentPageKey())}:${smallHash(requestUrl)}`;
  }

  function openFullBodyCacheDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);

    if (fullBodyCacheDbPromise) return fullBodyCacheDbPromise;

    fullBodyCacheDbPromise = new Promise((resolve) => {
      const request = indexedDB.open(FULL_BODY_CACHE_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(FULL_BODY_CACHE_STORE)) {
          const store = db.createObjectStore(FULL_BODY_CACHE_STORE, { keyPath: "key" });
          store.createIndex("pageKey", "pageKey", { unique: false });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });

    return fullBodyCacheDbPromise;
  }

  function idbRequestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  async function readFullBodyCache(requestUrl) {
    try {
      const db = await openFullBodyCacheDb();
      if (!db) return null;

      const key = makeFullBodyCacheKey(requestUrl);
      const tx = db.transaction(FULL_BODY_CACHE_STORE, "readonly");
      const store = tx.objectStore(FULL_BODY_CACHE_STORE);
      const entry = await idbRequestToPromise(store.get(key));

      if (!entry || entry.pageKey !== currentPageKey()) return null;
      if (entry.requestUrl !== requestUrl) return null;
      if (!entry.body || typeof entry.body !== "string") return null;

      const ageMs = Date.now() - Number(entry.updatedAt || 0);
      if (!Number.isFinite(ageMs) || ageMs > FULL_BODY_CACHE_TTL_MS) return null;

      return entry;
    } catch (error) {
      console.info("[GPT Local Speed Booster] full-body cache read skipped", String(error));
      return null;
    }
  }

  function scheduleFullBodyCache(requestUrl, bodyText) {
    if (!bodyText || bodyText.length > MAX_FULL_BODY_CACHE_CHARS) return;

    setTimeout(() => {
      writeFullBodyCache(requestUrl, bodyText).catch((error) => {
        console.info("[GPT Local Speed Booster] full-body cache write skipped", String(error));
      });
    }, 0);
  }

  async function writeFullBodyCache(requestUrl, bodyText) {
    const db = await openFullBodyCacheDb();
    if (!db) return false;

    const pageKey = currentPageKey();
    const entry = {
      key: makeFullBodyCacheKey(requestUrl),
      pageKey,
      requestUrl,
      body: bodyText,
      bodyChars: bodyText.length,
      updatedAt: Date.now()
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction(FULL_BODY_CACHE_STORE, "readwrite");
      const store = tx.objectStore(FULL_BODY_CACHE_STORE);

      store.put(entry);

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });

    await cleanupFullBodyCache(db, pageKey);

    console.info("[GPT Local Speed Booster] full-body cache stored", {
      bodyChars: bodyText.length,
      pageKey,
      cacheVersion: "idb-full-v1"
    });

    return true;
  }

  async function cleanupFullBodyCache(db, pageKey) {
    try {
      const tx = db.transaction(FULL_BODY_CACHE_STORE, "readwrite");
      const store = tx.objectStore(FULL_BODY_CACHE_STORE);
      const entries = await idbRequestToPromise(store.getAll());
      const now = Date.now();

      const sorted = entries
        .filter((entry) => entry && entry.key)
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

      let keptForPage = 0;

      for (const entry of sorted) {
        const expired = now - Number(entry.updatedAt || 0) > FULL_BODY_CACHE_TTL_MS;
        const samePage = entry.pageKey === pageKey;

        if (expired || (samePage && keptForPage >= MAX_FULL_BODY_CACHE_ENTRIES)) {
          store.delete(entry.key);
          continue;
        }

        if (samePage) {
          keptForPage += 1;
        }
      }
    } catch {
      // Non-critical.
    }
  }

  function pruneFullBodyCacheEntry(requestUrl, entry) {
    try {
      const timingStart = performance.now();

      const parseStart = performance.now();
      const conversation = JSON.parse(entry.body);
      const parseMs = performance.now() - parseStart;

      const pruneStart = performance.now();
      const result = window.GPTLocalSpeedPruner?.pruneConversationTree(conversation, {
        visibleLimit: state.visibleLimit,
        extraMessages: state.extraMessages
      });
      const pruneMs = performance.now() - pruneStart;

      if (!result) return null;

      let stringifyMs = 0;
      let patchedBody = entry.body;

      if (result.changed) {
        const stringifyStart = performance.now();
        patchedBody = JSON.stringify(result.conversation);
        stringifyMs = performance.now() - stringifyStart;
      }

      const timing = {
        readMs: 0,
        parseMs: Math.round(parseMs),
        pruneMs: Math.round(pruneMs),
        stringifyMs: Math.round(stringifyMs),
        totalMs: Math.round(performance.now() - timingStart)
      };

      postStatus({
        changed: result.changed,
        totalVisibleMessages: result.totalVisibleMessages,
        keptVisibleMessages: result.keptVisibleMessages,
        hasOlderMessages: result.hasOlderMessages,
        extraMessages: state.extraMessages,
        timing,
        cacheHit: true,
        cacheLayer: "full-body-idb"
      });

      console.info("[GPT Local Speed Booster] full-body cache hit", {
        kept: result.keptVisibleMessages,
        total: result.totalVisibleMessages,
        extraMessages: state.extraMessages,
        timing,
        cacheVersion: "idb-full-v1"
      });

      scheduleNextBodyCache(requestUrl, conversation, result);

      return makeResponseFromBody(patchedBody, requestUrl);
    } catch (error) {
      console.info("[GPT Local Speed Booster] full-body cache hit failed", String(error));
      return null;
    }
  }

  function readCacheIndex() {
    try {
      const raw = sessionStorage.getItem(NEXT_BODY_CACHE_INDEX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];

      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeCacheIndex(items) {
    try {
      sessionStorage.setItem(NEXT_BODY_CACHE_INDEX_KEY, JSON.stringify(items));
    } catch {
      // Non-critical.
    }
  }

  function clearNextBodyCaches() {
    try {
      sessionStorage.removeItem(NEXT_BODY_CACHE_KEY);
    } catch {
      // Non-critical.
    }

    const index = readCacheIndex();

    for (const item of index) {
      if (!item?.key) continue;

      try {
        sessionStorage.removeItem(item.key);
      } catch {
        // Non-critical.
      }
    }

    writeCacheIndex([]);
  }

  function readNextBodyCache(requestUrl) {
    try {
      const key = makeCacheKey(requestUrl, state.extraMessages);
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;

      const cache = JSON.parse(raw);
      if (!cache || cache.pageKey !== currentPageKey()) return null;
      if (cache.requestUrl !== requestUrl) return null;
      if (cache.visibleLimit !== state.visibleLimit) return null;
      if (cache.extraMessages !== state.extraMessages) return null;
      if (!cache.body || typeof cache.body !== "string") return null;

      const ageMs = Date.now() - Number(cache.updatedAt || 0);
      if (!Number.isFinite(ageMs) || ageMs > 10 * 60 * 1000) return null;

      return cache;
    } catch {
      return null;
    }
  }

  function writeNextBodyCache(requestUrl, targetExtraMessages, body, status) {
    try {
      if (!body || body.length > MAX_CACHED_BODY_CHARS) {
        return false;
      }

      const key = makeCacheKey(requestUrl, targetExtraMessages);
      const cache = {
        pageKey: currentPageKey(),
        requestUrl,
        visibleLimit: state.visibleLimit,
        extraMessages: targetExtraMessages,
        body,
        status,
        updatedAt: Date.now()
      };

      sessionStorage.setItem(key, JSON.stringify(cache));

      const existing = readCacheIndex()
        .filter((item) => item?.key && item.key !== key)
        .filter((item) => item.pageKey === currentPageKey());

      const nextIndex = [
        ...existing,
        {
          key,
          pageKey: currentPageKey(),
          requestUrl,
          visibleLimit: state.visibleLimit,
          extraMessages: targetExtraMessages,
          bodyChars: body.length,
          updatedAt: Date.now()
        }
      ].sort((left, right) => left.extraMessages - right.extraMessages);

      let totalChars = 0;
      const kept = [];

      for (const item of nextIndex) {
        totalChars += Number(item.bodyChars || 0);

        if (totalChars <= MAX_TOTAL_CACHED_BODY_CHARS) {
          kept.push(item);
        } else {
          try {
            sessionStorage.removeItem(item.key);
          } catch {
            // Non-critical.
          }
        }
      }

      writeCacheIndex(kept);
      return true;
    } catch (error) {
      console.info("[GPT Local Speed Booster] next-body cache skipped", String(error));
      return false;
    }
  }

  function scheduleNextBodyCache(requestUrl, conversation, currentResult) {
    if (!currentResult?.hasOlderMessages) return;

    const startExtraMessages = state.extraMessages;

    // Run after the patched response has been returned to ChatGPT. This avoids
    // making initial render wait for the optional cache.
    setTimeout(() => {
      try {
        const start = performance.now();
        let prepared = 0;
        let skipped = 0;
        let stoppedAt = null;

        for (let step = 1; step <= MAX_CACHE_AHEAD_STEPS; step += 1) {
          const targetExtraMessages = startExtraMessages + state.visibleLimit * step;

          const nextResult = window.GPTLocalSpeedPruner?.pruneConversationTree(conversation, {
            visibleLimit: state.visibleLimit,
            extraMessages: targetExtraMessages
          });

          if (!nextResult?.changed) {
            stoppedAt = targetExtraMessages;
            break;
          }

          const body = JSON.stringify(nextResult.conversation);
          const status = {
            changed: nextResult.changed,
            totalVisibleMessages: nextResult.totalVisibleMessages,
            keptVisibleMessages: nextResult.keptVisibleMessages,
            hasOlderMessages: nextResult.hasOlderMessages,
            extraMessages: targetExtraMessages,
            timing: {
              readMs: 0,
              parseMs: 0,
              pruneMs: 0,
              stringifyMs: 0,
              totalMs: Math.round(performance.now() - start)
            },
            cachePrepared: true
          };

          const cached = writeNextBodyCache(requestUrl, targetExtraMessages, body, status);

          if (cached) {
            prepared += 1;
          } else {
            skipped += 1;
          }

          if (!nextResult.hasOlderMessages) {
            stoppedAt = targetExtraMessages;
            break;
          }
        }

        console.info("[GPT Local Speed Booster] next-body cache batch", {
          prepared,
          skipped,
          startExtraMessages,
          visibleLimit: state.visibleLimit,
          stoppedAt,
          prepareMs: Math.round(performance.now() - start)
        });
      } catch (error) {
        console.info("[GPT Local Speed Booster] next-body cache batch failed", String(error));
      }
    }, 0);
  }

  function postStatus(status) {
    state.lastStatus = {
      ...status,
      enabled: state.enabled,
      visibleLimit: state.visibleLimit,
      extraMessages: state.extraMessages,
      url: window.location.href
    };

    window.postMessage({
      source: PAGE_SOURCE,
      type: "status",
      payload: state.lastStatus
    }, "*");
  }

  window.fetch = async function chatSmootherFetch(...args) {
    const [input, init] = args;

    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ||
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    if (!isConversationRequest(url, method)) {
      return originalFetch.apply(this, args);
    }

    if (state.enabled) {
      const cached = readNextBodyCache(url);

      if (cached) {
        const timing = {
          readMs: 0,
          parseMs: 0,
          pruneMs: 0,
          stringifyMs: 0,
          totalMs: 0
        };

        postStatus({
          ...(cached.status || {}),
          timing,
          cacheHit: true,
          extraMessages: state.extraMessages
        });

        console.info("[GPT Local Speed Booster] conversation cache hit", {
          kept: cached.status?.keptVisibleMessages,
          total: cached.status?.totalVisibleMessages,
          extraMessages: state.extraMessages,
          cacheVersion: 2
        });

        return makeResponseFromBody(cached.body, url);
      }

      const fullBodyCache = await readFullBodyCache(url);
      if (fullBodyCache) {
        const fullBodyResponse = pruneFullBodyCacheEntry(url, fullBodyCache);
        if (fullBodyResponse) {
          return fullBodyResponse;
        }
      }
    }

    const response = await originalFetch.apply(this, args);

    if (!state.enabled) {
      postStatus({
        changed: false,
        totalVisibleMessages: 0,
        keptVisibleMessages: 0,
        hasOlderMessages: false,
        reason: "disabled"
      });

      return response;
    }

    let text = null;

    try {
      const timingStart = performance.now();

      const readStart = performance.now();
      text = await response.text();
      const readMs = performance.now() - readStart;

      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }

      scheduleFullBodyCache(url, text);

      const parseStart = performance.now();
      const conversation = JSON.parse(text);
      const parseMs = performance.now() - parseStart;

      const storedExtraMessages = typeof readStoredExtraMessages === "function"
        ? readStoredExtraMessages()
        : 0;

      // Important for ChatGPT SPA navigation: only current-URL handoff should
      // override the live state. If no handoff exists, keep the same-page
      // config value sent by the agent.
      if (storedExtraMessages > 0) {
        state.extraMessages = storedExtraMessages;
      }

      const pruneStart = performance.now();
      const result = window.GPTLocalSpeedPruner?.pruneConversationTree(conversation, {
        visibleLimit: state.visibleLimit,
        extraMessages: state.extraMessages
      });
      const pruneMs = performance.now() - pruneStart;

      if (!result) {
        return rebuildOriginalResponse(response, text);
      }

      let stringifyMs = 0;
      let patchedBody = null;

      if (result.changed) {
        const stringifyStart = performance.now();
        patchedBody = JSON.stringify(result.conversation);
        stringifyMs = performance.now() - stringifyStart;
      }

      const timing = {
        readMs: Math.round(readMs),
        parseMs: Math.round(parseMs),
        pruneMs: Math.round(pruneMs),
        stringifyMs: Math.round(stringifyMs),
        totalMs: Math.round(performance.now() - timingStart)
      };

      postStatus({
        changed: result.changed,
        totalVisibleMessages: result.totalVisibleMessages,
        keptVisibleMessages: result.keptVisibleMessages,
        hasOlderMessages: result.hasOlderMessages,
        extraMessages: state.extraMessages,
        timing
      });

      console.info("[GPT Local Speed Booster] conversation timing", {
        changed: result.changed,
        kept: result.keptVisibleMessages,
        total: result.totalVisibleMessages,
        extraMessages: state.extraMessages,
        timing
      });

      scheduleNextBodyCache(url, conversation, result);

      if (!result.changed) {
        return rebuildOriginalResponse(response, text);
      }

      const patchedResponse = new Response(patchedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: patchJsonHeaders(response.headers)
      });

      try {
        Object.defineProperty(patchedResponse, "url", {
          value: response.url,
          configurable: true
        });
      } catch {
        // Non-critical.
      }

      return patchedResponse;
    } catch (error) {
      console.warn("[GPT Local Speed Booster] Could not process conversation response:", error);

      if (text != null) {
        return rebuildOriginalResponse(response, text);
      }

      return response;
    }
  };

  window.postMessage({
    source: PAGE_SOURCE,
    type: "ready"
  }, "*");
})();
