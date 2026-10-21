# Open Text Finder

**Search visible text across open Chrome tabs.** View a matching snippet and click a result to switch tabs and highlight matches.

## Version 1.0.0

- Search accessible open tabs in one go
- Match case and whole-word options
- Per-tab match counts and an overall total
- Click a result to switch to its tab, scroll to the first match, and highlight matches
- Dark, compact popup UI
- Local-only: no accounts, analytics, or external network requests
- MIT licensed

## Install in Chrome

1. Download `open-text-finder-v1.zip`.
2. Extract the ZIP.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder that directly contains `manifest.json`.
7. Pin **Open Text Finder** from Chrome's Extensions menu, then click its icon.

**Important:** `manifest.json` must be directly inside the folder you select. Do not select a parent folder or the ZIP file.

For `file://` pages, open the extension's **Details** page and turn on **Allow access to file URLs**.

## Usage

1. Open the web pages you want to search.
2. Click the Text Finder icon.
3. Enter a word or phrase and click **Search**.
4. Review counts and snippets; click a result to jump to its matching tab.

## Permissions

- `tabs`: identify open tabs and switch to a result.
- `scripting`: read page text and add temporary highlights.
- Host access for `http`, `https`, and `file` pages: needed so search can inspect more than just the active tab.

The extension does not send page content or search terms to a server.

## Limitations

- `chrome://` pages, Chrome Web Store pages, and some protected pages cannot be searched.
- Searches the page's visible DOM text, up to 1.5 million characters per tab.
- Does not search text inside browser-rendered PDFs, images, closed shadow roots, or cross-origin embedded frames.
- Highlights are temporary and may disappear after a site re-renders or the page reloads.
- Up to 500 matches per page are highlighted on click, to avoid slowing very long pages. The reported count is based on the searchable text snapshot.
- Whole-word matching uses JavaScript word boundaries, which may not behave ideally for every language or punctuation pattern.

## Development

The extension uses plain HTML, CSS, and JavaScript with Chrome Extension Manifest V3. No build step or package installation is required.

## License

MIT. See [LICENSE](LICENSE).


## Custom extension icon (v1.0.1)

The `icons/` folder contains the extension icons in 16, 32, 48, and 128 pixel PNG sizes, plus the editable SVG source. The manifest uses these for the extension listing and toolbar action.

To update an existing local installation, open `chrome://extensions` and click the circular **Reload** icon on Open Text Finder after replacing the old project files with these new files. To install as a separate copy, extract this ZIP and use **Load unpacked** on the extracted folder that directly contains `manifest.json`.
