'use strict';
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

function handleDownload(data, sendResponse) {
  const { url, filename } = data;

  // Sanitize filename: strip leading slashes, prevent path traversal
  const safeFilename = sanitizeFilename(filename);

  chrome.downloads.download(
    {
      url,
      filename: safeFilename,
      saveAs: false,
      conflictAction: 'uniquify',
    },
    downloadId => {
      if (chrome.runtime.lastError) {
        console.error('[BG] Download failed:', chrome.runtime.lastError.message);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    }
  );
}

function sanitizeFilename(filename) {
  // Strip any absolute path components and prevent traversal
  return filename
    .replace(/\.\.[/\\]/g, '')      // no ../ or ..\
    .replace(/^[/\\]+/, '')         // no leading slashes
    .replace(/[<>:"|?*\0]/g, '_')  // replace reserved chars
    .substring(0, 200);             // cap total length
}
