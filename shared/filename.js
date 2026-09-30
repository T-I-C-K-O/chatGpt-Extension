'use strict';
// Shared by the content script, the service worker (importScripts) and tests/sanitize.test.js.

// Clean one path segment so Chrome/Windows accept it as a folder or file name.
function sanitizeSegment(segment) {
  return String(segment)
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')          // no "." / ".." / hidden-dot segments
    .replace(/[. ]+$/, '')        // Windows rejects trailing dots and spaces
    .trim()
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)$/i, '_$1');
}

// Clean a relative "folder/sub/file.png" path; never absolute, never traverses.
function sanitizeDownloadPath(path) {
  const parts = String(path || '')
    .split(/[/\\]+/)
    .map(sanitizeSegment)
    .filter(Boolean);
  return parts.join('/').substring(0, 200);
}

if (typeof module !== 'undefined') module.exports = { sanitizeSegment, sanitizeDownloadPath };
