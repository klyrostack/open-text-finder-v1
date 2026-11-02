chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "open-text-finder-selection",
      title: "Find ‘%s’ across open tabs",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "open-text-finder-selection" || !info.selectionText) return;
  await chrome.storage.session.set({ pendingSearchTerm: info.selectionText });
  if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
});
