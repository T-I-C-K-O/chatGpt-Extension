# ChatGPT Image Batch Generator — Chrome Extension

A senior-architect-grade Chrome extension that automates bulk image generation from ChatGPT (DALL-E), mimicking the ZAPI FLOW workflow.

---

## Features

| Feature | Details |
|---|---|
| **Prompt Queue** | Enter 1–500+ prompts, one per line, or upload a `.txt` file |
| **Character Consistency** | Prepend a reusable character description to every prompt |
| **Auto-Download** | Images saved automatically to `Downloads/<your-folder>/` |
| **Serial Numbering** | Filenames like `001_a_red_bicycle.png`, `002_…` |
| **Configurable Delay** | Set seconds between generations (prevents rate-limits) |
| **Regenerate Last** | One-click re-run of the previous failed/skipped prompt |
| **Live Log** | Real-time generation log with timestamps in the popup |
| **Stop Anytime** | Cancel mid-queue; progress is preserved in the log |

---

## Setup — Step by Step

### 1. Generate the icons (one-time)

1. Open `icons/generate_icons.html` in Chrome (drag-and-drop it into the browser)
2. Click **"Generate & Download All Icons"**
3. Move the 4 downloaded files (`icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`) into the `icons/` folder

### 2. Load the extension in Chrome

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `chatGpt Extension` folder
5. The extension icon appears in the toolbar

### 3. Use it

1. Navigate to **[chatgpt.com](https://chatgpt.com)** — make sure you are logged in
2. Start a **new conversation** and ensure the **image generation model** (GPT-4o or DALL-E 3) is selected
3. Click the extension icon
4. Enter prompts in the **Prompt Queue** textarea (one per line) or upload a `.txt` file
5. Optionally toggle **Character Consistency** and describe your character
6. Set your **Download folder** name (images go to `Downloads/<folder>/`)
7. Click **START GENERATION** — the extension will type, send, wait, and download each image automatically

---

## File Structure

```
chatGpt Extension/
├── manifest.json              # MV3 Chrome extension config
├── popup/
│   ├── popup.html             # Extension UI
│   ├── popup.css              # Dark-theme styling
│   └── popup.js               # UI logic + tab communication
├── content/
│   └── content.js             # ChatGPT automation (DOM interaction)
├── background/
│   └── background.js          # Service worker — handles downloads
└── icons/
    ├── generate_icons.html    # Run once to produce PNG icons
    ├── icon16.png             # (after running generator)
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Architecture

```
Popup  ──sendMessage──▶  Content Script  (chatgpt.com)
  ▲                              │
  │  onMessage (progress)        │ sendMessage (download)
  │                              ▼
  └──────────────────  Background SW  ──▶  chrome.downloads
```

- **Popup** collects settings and sends `START_GENERATION` to the content script via `chrome.tabs.sendMessage`
- **Content script** drives the ChatGPT page: types prompts, clicks send, waits for the image, fetches it as a base64 data URL, and asks the background to download it
- **Background** calls `chrome.downloads.download()` (requires the `downloads` permission) and sanitises all file paths to prevent traversal

---

## Tips

- Set **Delay** to at least `4` seconds to avoid ChatGPT rate-limiting you
- For 100+ images, open a fresh ChatGPT conversation before starting
- If generation stalls, click **Stop**, scroll the ChatGPT tab to ensure it is active, and click **Start** again — the queue resumes from where it left off (re-enter the remaining prompts)
- The **Character Consistency** prompt is prepended verbatim; be specific: *"a cartoon fox with orange fur, green eyes, wearing a red scarf — consistent style across all images"*
- Downloaded images land in `C:\Users\<you>\Downloads\<folder-name>\`
