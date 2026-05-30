/*
 * GPT Local Speed Booster
 * Copyright (c) 2026 H1de0x
 * SPDX-License-Identifier: MIT
 */
(() => {
  "use strict";

  if (window.GPTLocalSpeedPruner) return;

  const IGNORED_ROLES = new Set(["system", "tool", "thinking"]);

  function clone(value) {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
  }

  function getRole(node) {
    return node?.message?.author?.role || null;
  }

  function isVisibleMessage(node) {
    if (!node?.message) return false;

    const role = getRole(node);
    return !IGNORED_ROLES.has(role);
  }

  function buildCurrentPath(mapping, currentNodeId) {
    const path = [];
    const seen = new Set();

    let cursor = currentNodeId;

    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      path.push(cursor);
      cursor = mapping[cursor].parent || null;
    }

    path.reverse();
    return path;
  }

  function pruneConversationTree(conversation, options = {}) {
    if (!conversation || typeof conversation !== "object") return null;
    if (!conversation.mapping || !conversation.current_node) return null;

    const mapping = conversation.mapping;
    const currentNodeId = conversation.current_node;
    const path = buildCurrentPath(mapping, currentNodeId);

    if (!path.length) return null;

    const baseLimit = Math.max(1, Number(options.visibleLimit) || 40);
    const extraMessages = Math.max(0, Number(options.extraMessages) || 0);
    const keepLimit = baseLimit + extraMessages;

    const visibleIds = path.filter((id) => isVisibleMessage(mapping[id]));
    const totalVisibleMessages = visibleIds.length;

    if (totalVisibleMessages <= keepLimit) {
      return {
        changed: false,
        conversation,
        totalVisibleMessages,
        keptVisibleMessages: totalVisibleMessages,
        hasOlderMessages: false
      };
    }

    const keptVisibleIds = visibleIds.slice(-keepLimit);
    const firstKeptVisibleId = keptVisibleIds[0];
    const firstKeptIndex = path.indexOf(firstKeptVisibleId);

    if (firstKeptIndex < 0) return null;

    const keptPath = path.slice(firstKeptIndex);
    const keptPathSet = new Set(keptPath);

    const rootId = conversation.root || "root";
    const newMapping = {};

    for (const id of keptPath) {
      const originalNode = mapping[id];
      if (!originalNode) continue;

      const node = clone(originalNode);
      node.children = Array.isArray(originalNode.children)
        ? originalNode.children.filter((childId) => keptPathSet.has(childId))
        : [];

      newMapping[id] = node;
    }

    for (let index = 0; index < keptPath.length; index++) {
      const id = keptPath[index];
      const previousId = keptPath[index - 1] || rootId;
      const nextId = keptPath[index + 1] || null;

      if (!newMapping[id]) continue;

      newMapping[id].parent = previousId;
      newMapping[id].children = nextId ? [nextId] : [];
    }

    newMapping[rootId] = {
      id: rootId,
      message: null,
      parent: null,
      children: keptPath.length ? [keptPath[0]] : []
    };

    const patchedConversation = {
      ...conversation,
      mapping: newMapping,
      root: rootId,
      current_node: keptPath[keptPath.length - 1] || currentNodeId
    };

    return {
      changed: true,
      conversation: patchedConversation,
      totalVisibleMessages,
      keptVisibleMessages: keptVisibleIds.length,
      hasOlderMessages: keptVisibleIds.length < totalVisibleMessages
    };
  }

  window.GPTLocalSpeedPruner = {
    pruneConversationTree
  };
})();
