/*
 * GPT Local Speed Booster
 * Copyright (c) 2026 H1de0x
 * SPDX-License-Identifier: MIT
 */
(() => {
  "use strict";

  const SETTINGS_KEY = "gpt_local_speed_booster_settings";
  const DEFAULT_SETTINGS = {
    enabled: true,
    visibleLimit: 40,
    showBadge: true,
    showLoadMore: true
  };

  const extensionApi = typeof browser !== "undefined" ? browser : chrome;
  const usingPromiseApi = typeof browser !== "undefined";

  const nodes = {
    unsupported: document.getElementById("unsupported"),
    renderedStat: document.getElementById("renderedStat"),
    memoryStat: document.getElementById("memoryStat"),
    timingStat: document.getElementById("timingStat"),
    enabledInput: document.getElementById("enabledInput"),
    badgeInput: document.getElementById("badgeInput"),
    loadMoreInput: document.getElementById("loadMoreInput"),
    limitInput: document.getElementById("limitInput"),
    saveButton: document.getElementById("saveButton"),
    resetLoadedButton: document.getElementById("resetLoadedButton")
  };

  let activeTab = null;
  let currentSettings = { ...DEFAULT_SETTINGS };

  init();

  async function init() {
    activeTab = await getActiveTab();

    if (!isChatGptUrl(activeTab?.url || "")) {
      nodes.unsupported.classList.remove("hidden");
    }

    const state = await askContentScript("get-state");
    currentSettings = normalizeSettings(state?.settings || await loadStoredSettings());

    renderSettings(currentSettings);
    renderStats(state?.status || null);

    nodes.saveButton.addEventListener("click", saveSettings);

    if (nodes.resetLoadedButton) {
      nodes.resetLoadedButton.addEventListener("click", resetLoadedMessages);
    }
  }

  function getActiveTab() {
    if (usingPromiseApi) {
      return extensionApi.tabs.query({ active: true, currentWindow: true })
        .then((tabs) => tabs[0] || null);
    }

    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs[0] || null);
      });
    });
  }

  function storageGet(defaults) {
    if (usingPromiseApi) return extensionApi.storage.local.get(defaults);

    return new Promise((resolve) => {
      chrome.storage.local.get(defaults, resolve);
    });
  }

  async function loadStoredSettings() {
    const data = await storageGet({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    return data[SETTINGS_KEY] || DEFAULT_SETTINGS;
  }

  function sendTabMessage(tabId, message) {
    if (!tabId) return Promise.resolve(null);

    if (usingPromiseApi) {
      return extensionApi.tabs.sendMessage(tabId, message).catch(() => null);
    }

    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }

        resolve(response || null);
      });
    });
  }

  function askContentScript(type, payload = {}) {
    return sendTabMessage(activeTab?.id, {
      target: "gpt-local-speed-booster:agent",
      type,
      payload
    });
  }

  function isChatGptUrl(url) {
    return url.startsWith("https://chatgpt.com/") ||
      url.startsWith("https://chat.openai.com/");
  }

  function normalizeSettings(settings) {
    const input = settings || {};
    return {
      enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_SETTINGS.enabled,
      showBadge: typeof input.showBadge === "boolean" ? input.showBadge : DEFAULT_SETTINGS.showBadge,
      showLoadMore: typeof input.showLoadMore === "boolean" ? input.showLoadMore : DEFAULT_SETTINGS.showLoadMore,
      visibleLimit: clampInteger(input.visibleLimit, 1, 200, DEFAULT_SETTINGS.visibleLimit)
    };
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;

    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function renderSettings(settings) {
    nodes.enabledInput.checked = settings.enabled;
    nodes.badgeInput.checked = settings.showBadge;

    if (nodes.loadMoreInput) {
      nodes.loadMoreInput.checked = settings.showLoadMore;
    }

    nodes.limitInput.value = settings.visibleLimit;
  }

  function renderStats(status) {
    if (!status || !status.totalVisibleMessages) {
      nodes.renderedStat.textContent = "—";
      nodes.memoryStat.textContent = "—";
      if (nodes.timingStat) nodes.timingStat.textContent = "—";
      return;
    }

    const total = status.totalVisibleMessages || 0;
    const kept = status.keptVisibleMessages || total;
    const saved = total > 0 ? Math.max(0, Math.round(((total - kept) / total) * 100)) : 0;

    nodes.renderedStat.textContent = `${kept}/${total}`;
    nodes.memoryStat.textContent = `${saved}%`;

    if (nodes.timingStat) {
      const timing = status.timing || {};
      nodes.timingStat.textContent = status.cacheHit
        ? "cache hit"
        : (timing.totalMs ? `${timing.totalMs} ms` : "—");
    }
  }

  async function saveSettings() {
    const nextSettings = normalizeSettings({
      enabled: nodes.enabledInput.checked,
      showBadge: nodes.badgeInput.checked,
      showLoadMore: nodes.loadMoreInput ? nodes.loadMoreInput.checked : true,
      visibleLimit: nodes.limitInput.value
    });

    nodes.saveButton.disabled = true;
    nodes.saveButton.textContent = "Saving…";

    const result = await askContentScript("update-settings", nextSettings);
    currentSettings = normalizeSettings(result?.settings || nextSettings);

    renderSettings(currentSettings);
    renderStats(result?.status || null);

    if (result?.reloadScheduled) {
      nodes.saveButton.textContent = "Saved, reloading…";
      window.close();
      return;
    }

    nodes.saveButton.textContent = "Saved";
    setTimeout(() => {
      nodes.saveButton.disabled = false;
      nodes.saveButton.textContent = "Save settings";
    }, 900);
  }


  async function resetLoadedMessages() {
    if (nodes.resetLoadedButton) {
      nodes.resetLoadedButton.disabled = true;
      nodes.resetLoadedButton.textContent = "Resetting…";
    }

    await askContentScript("reset-extra-and-reload");
    window.close();
  }
})();
