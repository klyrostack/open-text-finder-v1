const form = document.getElementById("search-form");
const queryInput = document.getElementById("query");
const searchButton = document.getElementById("search-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const clearButton = document.getElementById("clear-button");
const resultsArea = document.querySelector(".results-area");
const scopeSelect = document.getElementById("search-scope");
const saveHistory = document.getElementById("save-history");
const historyClearButton = document.getElementById("clear-history");
const recentSearchesEl = document.getElementById("recent-searches");
const tabPicker = document.getElementById("tab-picker");
const tabChoices = document.getElementById("tab-choices");
let lastSearchState = null;

async function populateTabChoices(selectedIds = []) {
  const tabs = await chrome.tabs.query({});
  tabChoices.replaceChildren();
  const selectable = tabs.filter(tab => tab.id && /^(https?:|file:)/i.test(tab.url || ""));
  if (!selectable.length) {
    tabChoices.textContent = "No accessible tabs are open.";
    return;
  }
  const actions = document.createElement("div");
  actions.className = "tab-choice-actions";
  for (const [label, value] of [["All", true], ["None", false]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = label;
    button.addEventListener("click", () => tabChoices.querySelectorAll("input[type=checkbox]").forEach(input => input.checked = value));
    actions.append(button);
  }
  tabChoices.append(actions);
  for (const tab of selectable) {
    const label = document.createElement("label");
    label.className = "tab-choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(tab.id);
    input.checked = selectedIds.includes(tab.id);
    const title = document.createElement("span");
    title.textContent = tab.title || tab.url;
    title.title = tab.url;
    label.append(input, title);
    tabChoices.append(label);
  }
}

scopeSelect.addEventListener("change", () => {
  const showPicker = scopeSelect.value === "selected";
  tabPicker.hidden = !showPicker;
  if (showPicker && !tabChoices.querySelector("input[type=checkbox]")) populateTabChoices();
});

async function renderRecentSearches() {
  const { recentSearches = [], saveRecentSearches = false } = await chrome.storage.local.get(["recentSearches", "saveRecentSearches"]);
  saveHistory.checked = saveRecentSearches;
  recentSearchesEl.replaceChildren();
  recentSearchesEl.classList.toggle("hidden", !saveRecentSearches || !recentSearches.length);
  for (const term of recentSearches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-search";
    button.textContent = term;
    button.title = `Search again for ${term}`;
    button.addEventListener("click", () => { queryInput.value = term; form.requestSubmit(); });
    recentSearchesEl.append(button);
  }
}

async function rememberSearch(term) {
  if (!saveHistory.checked) return;
  const { recentSearches = [] } = await chrome.storage.local.get("recentSearches");
  const updated = [term, ...recentSearches.filter(item => item !== term)].slice(0, 5);
  await chrome.storage.local.set({ recentSearches: updated, saveRecentSearches: true });
  await renderRecentSearches();
}

saveHistory.addEventListener("change", async () => {
  await chrome.storage.local.set({ saveRecentSearches: saveHistory.checked });
  if (!saveHistory.checked) await chrome.storage.local.remove("recentSearches");
  await renderRecentSearches();
});
historyClearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("recentSearches");
  await renderRecentSearches();
});

const MAX_TEXT_PER_TAB = 1_500_000;
const MAX_HIGHLIGHTS_PER_TAB = 500;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(term, wholeWord) {
  const escaped = escapeRegExp(term);
  return (wholeWord ? "\\b" : "") + escaped + (wholeWord ? "\\b" : "");
}

function makeSnippet(text, matchIndex, matchLength) {
  if (!text) return "";
  const beforeStart = Math.max(0, matchIndex - 72);
  const afterEnd = Math.min(text.length, matchIndex + matchLength + 105);
  const excerpt = text.slice(beforeStart, afterEnd).replace(/\s+/g, " ");
  const localIndex = matchIndex - beforeStart;
  const safeStart = escapeHtml(excerpt.slice(0, localIndex));
  const safeMatch = escapeHtml(excerpt.slice(localIndex, localIndex + matchLength));
  const safeEnd = escapeHtml(excerpt.slice(localIndex + matchLength));
  return `${beforeStart > 0 ? "…" : ""}${safeStart}<mark>${safeMatch}</mark>${safeEnd}${afterEnd < text.length ? "…" : ""}`;
}

async function searchOneTab(tab, term, matchCase, wholeWord) {
  if (!tab.id || !tab.url || !/^(https?:|file:)/i.test(tab.url)) {
    return { skipped: true, reason: "restricted" };
  }
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (needle, caseSensitive, wholeWordMatch, maxChars) => {
        const rawText = document.body?.innerText || "";
        const text = rawText.slice(0, maxChars);
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = (wholeWordMatch ? "\\b" : "") + escaped + (wholeWordMatch ? "\\b" : "");
        const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
        let count = 0;
        const snippets = [];
        let match;
        while ((match = regex.exec(text)) !== null) {
          if (snippets.length < 3) {
            const start = Math.max(0, match.index - 72);
            const end = Math.min(text.length, match.index + match[0].length + 105);
            snippets.push({ text: text.slice(start, end), offset: match.index - start, length: match[0].length, startsEarlier: start > 0 });
          }
          count += 1;
          if (!match[0].length) regex.lastIndex += 1;
        }
        return {
          title: document.title || "",
          count,
          snippets,
          truncated: rawText.length > maxChars
        };
      },
      args: [term, matchCase, wholeWord, MAX_TEXT_PER_TAB]
    });
    const result = injection?.[0]?.result;
    if (!result || !result.count) return null;
    // The snippet is assembled by a dedicated safe renderer below.
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      title: result.title || tab.title || "Untitled tab",
      url: tab.url,
      count: result.count,
      snippets: result.snippets,
      truncated: result.truncated
    };
  } catch (error) {
    return { skipped: true, reason: "inaccessible" };
  }
}

function renderSnippet(snippet) {
  const text = snippet?.text || "";
  if (!text) return "";
  const idx = Math.min(Math.max(0, snippet.offset), text.length);
  const endIdx = Math.min(text.length, idx + snippet.length);
  return `${snippet.startsEarlier ? "…" : ""}${escapeHtml(text.slice(0, idx))}<mark>${escapeHtml(text.slice(idx, endIdx))}</mark>${escapeHtml(text.slice(endIdx))}`;
}

function showEmpty(title, body) {
  resultsEl.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${escapeHtml(body)}</div>`;
}

function resetView() {
  resultsEl.replaceChildren();
  statusEl.textContent = "Search the text on accessible tabs.";
  clearButton.classList.add("hidden");
  resultsArea.setAttribute("aria-busy", "false");
}

async function highlightMatches(item, term, matchCase, wholeWord, requestedIndex = 0) {
  // Apply highlights before switching tabs, because Chrome destroys the
  // popup as soon as its browser window loses focus.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: item.tabId },
      func: (needle, caseSensitive, wholeWordMatch, maxHighlights, requestedIndex) => {
        // Clear highlights left by the previous search without removing page content.
        document.querySelectorAll("mark[data-open-text-finder]").forEach(mark => {
          mark.replaceWith(document.createTextNode(mark.textContent || ""));
        });

        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = (wholeWordMatch ? "\\b" : "") + escaped + (wholeWordMatch ? "\\b" : "");
        const testRegex = new RegExp(pattern, caseSensitive ? "" : "i");
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|OPTION|MARK)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
            if (parent.closest("[data-open-text-finder]")) return NodeFilter.FILTER_REJECT;
            return testRegex.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        });

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        let firstMark = null;
        let activeMark = null;
        let total = 0;

        for (const node of nodes) {
          if (total >= maxHighlights) break;
          const value = node.nodeValue;
          const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
          const fragment = document.createDocumentFragment();
          let lastIndex = 0;
          let match;
          let changed = false;

          while ((match = regex.exec(value)) !== null && total < maxHighlights) {
            fragment.append(document.createTextNode(value.slice(lastIndex, match.index)));
            const mark = document.createElement("mark");
            mark.dataset.openTextFinder = "true";
            mark.dataset.openTextFinderIndex = String(total);
            mark.style.cssText = "background:#d9f779!important;color:#171b0b!important;outline:1px solid #a5c74a;border-radius:2px;";
            mark.textContent = match[0];
            fragment.append(mark);
            if (!firstMark) firstMark = mark;
            if (total === requestedIndex) activeMark = mark;
            lastIndex = match.index + match[0].length;
            total++;
            changed = true;
            if (!match[0].length) regex.lastIndex++;
          }
          if (changed) {
            fragment.append(document.createTextNode(value.slice(lastIndex)));
            node.parentNode.replaceChild(fragment, node);
          }
        }

        const targetMark = activeMark || firstMark;
        if (targetMark) {
          targetMark.style.outline = "2px solid #9ab83e";
          targetMark.scrollIntoView({ behavior: "smooth", block: "center" });
          targetMark.setAttribute("tabindex", "-1");
          targetMark.focus({ preventScroll: true });
        }
        return { highlighted: total, limited: total >= maxHighlights };
      },
      args: [term, matchCase, wholeWord, MAX_HIGHLIGHTS_PER_TAB, requestedIndex]
    });
  } catch (error) {
    // Some browser pages disallow injected scripts. The tab will still be opened.
  }
  await chrome.tabs.update(item.tabId, { active: true });
  if (item.windowId !== undefined && item.windowId !== null) {
    await chrome.windows.update(item.windowId, { focused: true });
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const term = queryInput.value.trim();
  if (!term) {
    queryInput.focus();
    return;
  }

  searchButton.disabled = true;
  searchButton.textContent = "Searching…";
  resultsArea.setAttribute("aria-busy", "true");
  clearButton.classList.add("hidden");
  resultsEl.replaceChildren();
  statusEl.textContent = "Searching open tabs…";

  const matchCase = document.getElementById("case-sensitive").checked;
  const wholeWord = document.getElementById("whole-word").checked;
  const selectedTabIds = scopeSelect.value === "selected"
    ? [...tabChoices.querySelectorAll("input[type=checkbox]:checked")].map(input => Number(input.value))
    : [];
  lastSearchState = {
    term, matchCase, wholeWord, scope: scopeSelect.value, selectedTabIds,
    matchPositions: lastSearchState?.matchPositions || {}
  };
  await chrome.storage.session.set({ lastSearch: lastSearchState }).catch(() => {});

  try {
    let tabs = await chrome.tabs.query(scopeSelect.value === "window" ? { currentWindow: true } : {});
    if (scopeSelect.value === "selected") {
      if (!selectedTabIds.length) {
        statusEl.textContent = "Select at least one tab to search.";
        tabPicker.open = true;
        return;
      }
      const selected = new Set(selectedTabIds);
      tabs = tabs.filter(tab => selected.has(tab.id));
    }
    await rememberSearch(term);
    const tabResults = await Promise.all(tabs.map(tab => searchOneTab(tab, term, matchCase, wholeWord)));
    const matches = tabResults.filter(item => item && item.count > 0).sort((a, b) => b.count - a.count);
    const inaccessible = tabResults.filter(item => item && item.skipped).length;
    const totalMatches = matches.reduce((sum, item) => sum + item.count, 0);

    if (!matches.length) {
      statusEl.textContent = "Search complete";
      showEmpty("No matches found", inaccessible
        ? `No matches on accessible pages. ${inaccessible} restricted or protected tab(s) could not be searched.`
        : "Try a shorter phrase or turn off Match case / Whole word.");
      return;
    }

    statusEl.textContent = `${matches.length} matching tab${matches.length === 1 ? "" : "s"} · ${totalMatches.toLocaleString()} match${totalMatches === 1 ? "" : "es"}`;
    if (inaccessible) statusEl.textContent += ` · ${inaccessible} skipped`;
    clearButton.classList.remove("hidden");

    for (const item of matches) {
      const resultWrap = document.createElement("div");
      resultWrap.className = "result-wrap";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result";
      const heading = document.createElement("span");
      heading.className = "result-heading";
      const title = document.createElement("span");
      title.className = "result-title";
      title.textContent = item.title;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${item.count.toLocaleString()} match${item.count === 1 ? "" : "es"}`;
      heading.append(title, count);

      const url = document.createElement("span");
      url.className = "result-url";
      url.textContent = item.url;
      const snippets = document.createElement("span");
      snippets.className = "result-snippets";
      for (const excerpt of item.snippets || []) {
        const snippet = document.createElement("span");
        snippet.className = "snippet";
        snippet.innerHTML = renderSnippet(excerpt);
        snippets.append(snippet);
      }
      if (item.truncated) {
        const note = document.createElement("span");
        note.className = "result-truncated";
        note.textContent = "Search covered the first 1.5 million characters of this page.";
        snippets.append(note);
      }

      button.append(heading, url, snippets);
      const navigation = document.createElement("div");
      navigation.className = "match-navigation";
      const previous = document.createElement("button");
      previous.type = "button";
      previous.textContent = "Previous match";
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "Next match";
      const totalNavigable = Math.min(item.count, MAX_HIGHLIGHTS_PER_TAB);
      const storedPosition = Number(lastSearchState?.matchPositions?.[item.tabId] || 0);
      const position = Math.min(storedPosition, totalNavigable - 1);
      const indicator = document.createElement("span");
      indicator.textContent = `${position + 1} / ${totalNavigable}${item.count > totalNavigable ? "+" : ""}`;
      const navigate = async direction => {
        const current = Number(lastSearchState?.matchPositions?.[item.tabId] || 0);
        const target = (current + direction + totalNavigable) % totalNavigable;
        lastSearchState.matchPositions[item.tabId] = target;
        await chrome.storage.session.set({ lastSearch: lastSearchState }).catch(() => {});
        indicator.textContent = `${target + 1} / ${totalNavigable}${item.count > totalNavigable ? "+" : ""}`;
        await highlightMatches(item, term, matchCase, wholeWord, target);
      };
      previous.disabled = totalNavigable < 2;
      next.disabled = totalNavigable < 2;
      previous.addEventListener("click", () => navigate(-1));
      next.addEventListener("click", () => navigate(1));
      navigation.append(previous, indicator, next);
      button.addEventListener("click", () => highlightMatches(item, term, matchCase, wholeWord, position));
      resultWrap.append(button, navigation);
      resultsEl.append(resultWrap);
    }
  } catch (error) {
    statusEl.textContent = "Search couldn't finish";
    showEmpty("Something went wrong", "Try closing and reopening the popup, then search again.");
  } finally {
    searchButton.disabled = false;
    searchButton.textContent = "Search";
    resultsArea.setAttribute("aria-busy", "false");
  }
});

clearButton.addEventListener("click", async () => {
  resetView();
  await chrome.storage.session.remove("lastSearch").catch(() => {});
});
queryInput.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    queryInput.value = "";
    resetView();
    chrome.storage.session.remove("lastSearch").catch(() => {});
  }
});
document.addEventListener("DOMContentLoaded", () => queryInput.focus());
queryInput.focus();
renderRecentSearches().catch(() => {});
chrome.storage.session.get(["lastSearch", "pendingSearchTerm"]).then(async ({ lastSearch, pendingSearchTerm }) => {
  if (pendingSearchTerm) {
    lastSearch = { ...(lastSearch || {}), term: pendingSearchTerm, scope: "all", matchPositions: {} };
    await chrome.storage.session.set({ lastSearch }).catch(() => {});
    await chrome.storage.session.remove("pendingSearchTerm").catch(() => {});
  }
  if (!lastSearch?.term) return;
  lastSearchState = lastSearch;
  queryInput.value = lastSearch.term;
  document.getElementById("case-sensitive").checked = !!lastSearch.matchCase;
  document.getElementById("whole-word").checked = !!lastSearch.wholeWord;
  scopeSelect.value = ["window", "selected"].includes(lastSearch.scope) ? lastSearch.scope : "all";
  if (scopeSelect.value === "selected") {
    tabPicker.hidden = false;
    await populateTabChoices(lastSearch.selectedTabIds || []);
  }
  form.requestSubmit();
}).catch(() => {});
