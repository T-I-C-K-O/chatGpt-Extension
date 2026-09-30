'use strict';
chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
});
chrome.runtime.onStartup.addListener(configureSidePanel);

function configureSidePanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
// === ChatGPT Image Batch Generator — Background Service Worker ===

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DOWNLOAD_IMAGE') {
    handleDownload(message.data, sendResponse);
    return true; // keep channel open for async response
  }

  // Relay PROGRESS_UPDATE to popup (if open) and persist to storage
  if (message.action === 'PROGRESS_UPDATE') {
    // Persist so popup can read state after reopening
    chrome.storage.local.set({
      lastProgressUpdate: { ...message, ts: Date.now() },
    });
    // Forward to all extension views (popup)
    chrome.runtime.sendMessage(message).catch(() => { /* popup closed */ });
  }
});

const pendingDownloads = new Map(); // dedupeKey -> promise (only while in flight)

// Poll instead of relying on onChanged + an in-memory map: the MV3 service worker
// can be suspended mid-download, which would lose the map and hang the caller.
function waitForDownload(downloadId) {
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      chrome.downloads.search({ id: downloadId }, items => {
        const item = items && items[0];
        if (!item) return;
        if (item.state === 'complete') {
          clearInterval(timer);
          resolve({ success: true, downloadId });
        } else if (item.state === 'interrupted') {
          clearInterval(timer);
          resolve({ success: false, error: item.error || 'Download interrupted' });
        } else if (Date.now() - started > 120000) {
          clearInterval(timer);
          resolve({ success: false, error: 'Download timed out' });
        }
      });
    }, 400);
  });
}

function handleDownload(data, sendResponse) {
  const { url, filename, sourceKey } = data;
  const dedupeKey = sourceKey || url;

  if (!url) {
    sendResponse({ success: false, error: 'No image URL to download' });
    return;
  }

  // Only coalesce identical requests that are currently in flight. A persistent
  // "already downloaded" set silently skipped images whose URL was seen before.
  if (pendingDownloads.has(dedupeKey)) {
    pendingDownloads.get(dedupeKey).then(sendResponse);
    return;
  }

  const safeFilename = sanitizeFilename(filename);

  const downloadPromise = new Promise(resolve => {
    chrome.downloads.download(
      { url, filename: safeFilename, saveAs: false, conflictAction: 'uniquify' },
      downloadId => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          resolve({ success: false, error: chrome.runtime.lastError?.message || 'Download failed to start' });
          return;
        }
        waitForDownload(downloadId).then(resolve);
      }
    );
  }).finally(() => pendingDownloads.delete(dedupeKey));

  pendingDownloads.set(dedupeKey, downloadPromise);
  downloadPromise.then(sendResponse);
}

function sanitizeFilename(filename) {
  // Strip any absolute path components and prevent traversal
  return filename
    .replace(/\.\.[/\\]/g, '')      // no ../ or ..\
    .replace(/^[/\\]+/, '')         // no leading slashes
    .replace(/[<>:"|?*\0]/g, '_')  // replace reserved chars
    .substring(0, 200);             // cap total length
}
