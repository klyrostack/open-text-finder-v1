# Open Text Finder V2

V2 is built from the original V1 project. The toolbar popup and its dark-and-lime styling remain in place; these are additions inside that popup.

## Added features

- Search all open tabs, only the current window, or a manually selected set of tabs.
- Show up to three matching text snippets per tab and navigate to previous/next occurrences (up to 500 highlights per page).
- Save the last five search phrases locally when the user opts in; clear the list or disable history at any time.
- Restore the last query and its options when reopening the popup after switching to a result tab.
- Open the popup with Ctrl+Shift+F (the shortcut can be changed in `chrome://extensions/shortcuts`).
- Right-click selected text and choose “Find across open tabs”; Chrome versions that support the action popup API open the popup with that phrase filled in. Otherwise click the extension icon to run it.

## Load in Chrome

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this folder.
3. Click the extension toolbar icon to open the original popup.

The original V1 folder remains unchanged. Searches stay local; optional search history is stored on this device.
