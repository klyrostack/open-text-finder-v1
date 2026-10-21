const form = document.getElementById("search-form");
const queryInput = document.getElementById("query");
const searchButton = document.getElementById("search-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const clearButton = document.getElementById("clear-button");
const resultsArea = document.querySelector(".results-area");

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
        let firstIndex = -1;
        let firstLength = needle.length;
        let match;
        while ((match = regex.exec(text)) !== null) {
          if (firstIndex === -1) {
            firstIndex = match.index;
            firstLength = match[0].length;
          }
          count += 1;
          if (!match[0].length) regex.lastIndex += 1;
        }
        return {
          title: document.title || "",
          count,
          snippetText: firstIndex < 0 ? "" : text.slice(Math.max(0, firstIndex - 72), Math.min(text.length, firstIndex + firstLength + 105)),
          matchOffset: firstIndex < 0 ? -1 : Math.min(72, firstIndex),
          matchLength: firstLength,
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
      snippetText: result.snippetText,
      matchOffset: result.matchOffset,
      matchLength: result.matchLength,
      truncated: result.truncated
    };
  } catch (error) {
    return { skipped: true, reason: "inaccessible" };
  }
}

function renderSnippet(item) {
  // Reconstruct the context around the match with the exact match offset.
  const text = item.snippetText || "";
  if (!text) return "";
  const idx = Math.min(Math.max(0, item.matchOffset), text.length);
  const endIdx = Math.min(text.length, idx + item.matchLength);
  return `${idx > 0 ? "…" : ""}${escapeHtml(text.slice(0, idx))}<mark>${escapeHtml(text.slice(idx, endIdx))}</mark>${escapeHtml(text.slice(endIdx))}${item.truncated ? "…" : ""}`;
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

async function highlightMatches(item, term, matchCase, wholeWord) {
  // Focus the matching tab before injecting highlight markup.
  await chrome.tabs.update(item.tabId, { active: true });
  if (item.windowId !== undefined && item.windowId !== null) {
    await chrome.windows.update(item.windowId, { focused: true });
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: item.tabId },
      func: (needle, caseSensitive, wholeWordMatch, maxHighlights) => {
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
            mark.style.cssText = "background:#d9f779!important;color:#171b0b!important;outline:1px solid #a5c74a;border-radius:2px;";
            mark.textContent = match[0];
            fragment.append(mark);
            if (!firstMark) firstMark = mark;
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

        if (firstMark) {
          firstMark.scrollIntoView({ behavior: "smooth", block: "center" });
          firstMark.setAttribute("tabindex", "-1");
          firstMark.focus({ preventScroll: true });
        }
        return { highlighted: total, limited: total >= maxHighlights };
      },
      args: [term, matchCase, wholeWord, MAX_HIGHLIGHTS_PER_TAB]
    });
  } catch (error) {
    // Some browser pages disallow injected scripts. The tab will still be opened.
  }
  window.close();
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

  try {
    const tabs = await chrome.tabs.query({});
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
      const snippet = document.createElement("span");
      snippet.className = "snippet";
      snippet.innerHTML = renderSnippet(item);

      button.append(heading, url, snippet);
      button.addEventListener("click", () => highlightMatches(item, term, matchCase, wholeWord));
      resultsEl.append(button);
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

clearButton.addEventListener("click", resetView);
queryInput.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    queryInput.value = "";
    resetView();
  }
});
document.addEventListener("DOMContentLoaded", () => queryInput.focus());
queryInput.focus();
