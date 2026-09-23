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

const downloadedUrls = new Set();
const pendingDownloads = new Map();
const inFlightDownloads = new Map(); // downloadId -> resolve callback
const downloadedUrlsReady = chrome.storage.local.get('downloadedUrls').then(({ downloadedUrls: storedUrls = [] }) => {
  storedUrls.forEach(url => downloadedUrls.add(url));
});

// download() callback only confirms the request was queued, not that the file was saved
chrome.downloads.onChanged.addListener(delta => {
  const resolve = inFlightDownloads.get(delta.id);
  if (!resolve) return;

  if (delta.state?.current === 'complete') {
    inFlightDownloads.delete(delta.id);
    resolve({ success: true, downloadId: delta.id });
  } else if (delta.state?.current === 'interrupted') {
    inFlightDownloads.delete(delta.id);
    resolve({ success: false, error: delta.error?.current || 'Download interrupted' });
  }
});

function handleDownload(data, sendResponse) {
  const { url, filename, sourceKey } = data;
  const dedupeKey = sourceKey || url;

  downloadedUrlsReady.then(() => {
    if (!url || downloadedUrls.has(dedupeKey)) {
      sendResponse({ success: true, duplicate: Boolean(url) });
      return;
    }

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
          inFlightDownloads.set(downloadId, result => {
            if (result.success) {
              downloadedUrls.add(dedupeKey);
              chrome.storage.local.set({ downloadedUrls: [...downloadedUrls] });
            }
            pendingDownloads.delete(dedupeKey);
            resolve(result);
          });
        }
      );
    });

    pendingDownloads.set(dedupeKey, downloadPromise);
    downloadPromise.then(sendResponse);
  });
}

function sanitizeFilename(filename) {
  // Strip any absolute path components and prevent traversal
  return filename
    .replace(/\.\.[/\\]/g, '')      // no ../ or ..\
    .replace(/^[/\\]+/, '')         // no leading slashes
    .replace(/[<>:"|?*\0]/g, '_')  // replace reserved chars
    .substring(0, 200);             // cap total length
}
