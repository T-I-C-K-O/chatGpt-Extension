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

// File name for a scene: just the scene number, e.g. "Scene 12: ..." -> "scene_12".
// Prompts without a "Scene N" header fall back to their position in the queue.
function sceneBaseName(prompt, fallbackIndex) {
  const match = String(prompt || '').match(/^\s*Scene\s+(\d+)/i);
  const number = match ? Number.parseInt(match[1], 10) : fallbackIndex;
  return `scene_${number}`;
}

if (typeof module !== 'undefined') module.exports = { sanitizeSegment, sanitizeDownloadPath, sceneBaseName };
