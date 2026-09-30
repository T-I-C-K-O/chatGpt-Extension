'use strict';
// === ChatGPT Image Batch Generator — Content Script ===

// ==================== SELECTORS ====================
// Multiple fallbacks per element to survive ChatGPT DOM changes
const SEL = {
  INPUT: [
    '#prompt-textarea',
    'div[contenteditable="true"][data-id]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"]',
    'textarea[placeholder]',
  ],
  SEND: [
    'button[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
    'form button[type="submit"]',
  ],
  STOP: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
  ],
ASSISTANT: [
  '[data-message-author-role="assistant"]',
  'section[data-turn="assistant"]',
  '.agent-turn',
  '[data-testid*="conversation-turn"][data-testid*="assistant"]',
  'article[data-testid*="conversation-turn"]', // newer ChatGPT layout fallback
  'div[data-message-id]',                      // generic message container fallback
],
};

const TIMEOUTS = {
  GENERATION_DONE: 180_000,
  IMAGE_SETTLE: 1200,
  STREAMING_STABLE: 6000,
  IDLE_QUIET: 1500,
  IDLE_WAIT: 600_000,
};

// ==================== STATE ====================
let state = {
  isRunning:      false,
  queue:          [],
  currentIndex:   0,
  totalGenerated: 0,
  errorCount:     0,
  lastFullPrompt: null,
  lastFilename:   null,
  settings: {
    characterPrompt: '',
    downloadFolder:  'chatgpt-images',
    includeSerial:   true,
    autoDownload:    true,
    delay:           4000,
  },
};

// ==================== MESSAGE LISTENER ====================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'PING':
      sendResponse({ pong: true });
      break;

    case 'GET_STATUS':
      sendResponse({
        isRunning:      state.isRunning,
        currentIndex:   state.currentIndex,
        total:          state.queue.length,
        totalGenerated: state.totalGenerated,
        errorCount:     state.errorCount,
      });
      break;

    case 'START_GENERATION':
  if (state.isRunning) {
    sendResponse({ success: false, error: 'Generation already running' });
    break;
  }
  startGeneration(msg.data)
    .then(() => sendResponse({ success: true }))
    .catch(e => sendResponse({ success: false, error: e.message }));
  return true; // keep channel open

case 'STOP_GENERATION':
  state.isRunning = false;
  sendResponse({ success: true });
  break;

case 'REGENERATE_LAST':
  if (state.isRunning) {
    sendResponse({ success: false, error: 'Generation already running' });
    break;
  }
  if (!state.lastFullPrompt) {
    sendResponse({ success: false, error: 'Nothing to regenerate' });
  } else {
    regenerateLast()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  break;

case 'REGENERATE_INDEX': {
  if (state.isRunning) {
    sendResponse({ success: false, error: 'Generation already running' });
    break;
  }
  const { index, prompt } = msg.data;
  const full     = buildFullPrompt(prompt);
  const filename = buildFilename(prompt, index + 1);
  state.lastFullPrompt = full;
  state.lastFilename   = filename;
  state.isRunning      = true;
  generateOne(full, filename)
    .then(() => {
      state.isRunning = false;
      notify('RETRY_SUCCESS', { index });
      sendResponse({ success: true });
    })
    .catch(e => {
      state.isRunning = false;
      notify('RETRY_ERROR', { index, error: e.message });
      sendResponse({ success: false, error: e.message });
    });
  return true;
}
  }
});

// ==================== START ====================
async function startGeneration(data) {
  const prompts = [...new Set(
    (data.prompts || [])
      .map(prompt => String(prompt).trim())
      .filter(Boolean)
  )];
  if (!prompts.length) return;

  state.queue          = prompts;
  state.settings       = { ...state.settings, ...data };
  state.isRunning      = true;
  state.currentIndex   = 0;
  state.totalGenerated = 0;
  state.errorCount     = 0;

  await processQueue();
}

async function regenerateLast() {
  state.isRunning = true;
  try {
    await generateOne(state.lastFullPrompt, state.lastFilename);
  } finally {
    state.isRunning = false;
  }
}

// ==================== QUEUE LOOP ====================
async function processQueue() {
  while (state.currentIndex < state.queue.length && state.isRunning) {
    const raw      = state.queue[state.currentIndex];
    const full     = buildFullPrompt(raw);
    const filename = buildFilename(raw, state.currentIndex + 1);

    state.lastFullPrompt = full;
    state.lastFilename   = filename;

    notify('STARTED', { prompt: raw, currentIndex: state.currentIndex });

    let lastErr = null;
    for (let attempt = 0; attempt < 2 && state.isRunning; attempt++) {
      try {
        await generateOne(full, filename);
        state.totalGenerated++;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.error('[IBG] scene failed', state.currentIndex + 1, `attempt ${attempt + 1}`, err);
        if (err.fatal || !state.isRunning) break;
        // Never start anything new while ChatGPT is still working on this scene
        try { await settleChat(); } catch (e) { lastErr = e; break; }
      }
    }
    if (lastErr) {
      state.errorCount++;
      notify('ERROR', { error: lastErr.message, index: state.currentIndex });
      if (lastErr.fatal) { state.isRunning = false; }
    }

    state.currentIndex++;
    notify('PROGRESS', {
      currentIndex:   state.currentIndex,
      total:          state.queue.length,
      totalGenerated: state.totalGenerated,
      errorCount:     state.errorCount,
    });

    if (state.currentIndex < state.queue.length && state.isRunning) {
      if (state.settings.delay > 0) await sleep(state.settings.delay);
    }
  }

  const stopped = !state.isRunning;
  state.isRunning = false;
  notify(stopped ? 'STOPPED' : 'COMPLETE', {
    totalGenerated: state.totalGenerated,
    total:          state.queue.length,
    errorCount:     state.errorCount,
  });
}

// Busy = ChatGPT is generating. Checks the known stop-button selectors, plus any "stop" button
// inside the composer form (scoped so unrelated page buttons can't match).
function isChatBusy() {
  if (pickFirst(SEL.STOP)) return true;
  const form = pickFirst(SEL.INPUT)?.closest('form');
  return !!form && Array.from(form.querySelectorAll('button')).some(b =>
    /stop/i.test(b.getAttribute('aria-label') || '') || /stop/i.test(b.dataset.testid || ''));
}

// Strictly sequential: never start a prompt while ChatGPT is still working on the previous one.
// Idle = not busy for IDLE_QUIET ms in a row.
async function waitForIdle(timeoutMs) {
  const started = Date.now();
  let quietSince = 0;
  let announced = false;
  while (Date.now() - started < timeoutMs) {
    if (!state.isRunning) throw new Error('Stopped by user');
    if (isChatBusy()) {
      quietSince = 0;
      if (!announced && Date.now() - started > 3000) {
        announced = true;
        notify('WAITING', { text: 'Waiting for ChatGPT to finish…' });
      }
    } else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= TIMEOUTS.IDLE_QUIET) return true;
    await sleep(300);
  }
  return false;
}

// Wait for ChatGPT to finish; if it never does, press Stop so the next prompt can be sent.
async function settleChat() {
  if (await waitForIdle(TIMEOUTS.IDLE_WAIT)) return;
  pickFirst(SEL.STOP)?.click();
  if (!(await waitForIdle(15_000))) {
    const err = new Error('ChatGPT is still busy and could not be stopped — run aborted');
    err.fatal = true;
    throw err;
  }
}

async function generateOne(fullPrompt, filename) {
  if(!state.isRunning) throw new Error('Generation is not running');

  await settleChat();

  if (state.settings.characterBible) {
    await attachCharacterBible(state.settings.characterBible, state.settings.characterBibleName);
  }

  await typeInChatGPT(fullPrompt);
  await sleep(400);

  const watcher = watchForNewGeneratedImage();
  try {
    await clickSend();
  } catch (err) {
    watcher.cancel(err); // avoid leaving a stale observer running
    throw err;
  }

  const srcs = [...new Set(await watcher.promise)]; // .promise, not the watcher object

  if (state.settings.autoDownload !== false) {
    for (let i = 0; i < srcs.length; i++) {
      const fname = srcs.length > 1
        ? filename.replace(/\.png$/, `_${i + 1}.png`)
        : filename;

      await downloadImage(srcs[i], fname);
      notify('SAVED', { filename: fname });
    }
  }

  // Image is saved; let ChatGPT finish (it may still stream text). If it never settles, stop it
  // so the next prompt can be sent.
  await settleChat();
}

async function attachCharacterBible(dataUrl, fileName = 'character-bible.png') {
  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) throw new Error('ChatGPT file upload input not found');

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const file = new File([blob], fileName, { type: blob.type || 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1200);

  // Wait (bounded) for the upload to finish: the attachment must have an <img> and the send button must be enabled
  for (let i = 0; i < 40; i++) {
    const sendBtn = pickFirst(SEL.SEND);
    const uploading = document.querySelector('form [role="progressbar"], form [class*="spinner" i], form .animate-spin');
    if (!uploading && sendBtn === null) break; // send button only appears once there is content
    if (!uploading && sendBtn && !sendBtn.disabled) break;
    await sleep(500);
  }
}

// ==================== CHATGPT DOM INTERACTION ====================
async function typeInChatGPT(text) {
  const input = pickFirst(SEL.INPUT);
  if (!input) throw new Error('ChatGPT input field not found. Make sure you are on the ChatGPT page and it is fully loaded.');

  for (let attempt = 0; attempt < 3; attempt++) {
    input.click();
    input.focus();
    await sleep(200);

    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(80);

    const inserted = document.execCommand('insertText', false, text);
    if (!inserted || !hasText(input, text)) {
      if (input.contentEditable === 'true') {
        input.innerHTML = `<p>${escapeHtml(text)}</p>`;
      } else {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(input, text);
        else input.value = text;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    await sleep(350);
    if (hasText(input, text)) return;
  }

  throw new Error('ChatGPT did not accept the next scene prompt');
}

async function clickSend() {
  // Re-query each time to get the fresh enabled state
  let retries = 0;
  while (retries < 40) {
    const btn = pickFirst(SEL.SEND);
    if (btn && !btn.disabled) {
      btn.click();
      return;
    }
    await sleep(400);
    retries++;
  }
  throw new Error('Send button not found or disabled after typing prompt');
}

// ==================== IMAGE WATCHER ====================

function countAssistantMessages() {
  for (const sel of SEL.ASSISTANT) {
    const n = document.querySelectorAll(sel).length;
    if (n > 0) return n;
  }
  return 0;
}

function getLastAssistantMessage() {
  for (const sel of SEL.ASSISTANT) {
    const all = document.querySelectorAll(sel);
    if (all.length) return all[all.length - 1];
  }
  return null;
}

function getAllAssistantMessages() {
  for (const sel of SEL.ASSISTANT) {
    const all = document.querySelectorAll(sel);
    if (all.length) return Array.from(all);
  }
  return [];
}

function isGeneratedImage(img) {
  return (
    img.naturalWidth  >= 64 &&
    img.naturalHeight >= 64 &&
    !!img.src &&
    !/\/avatar\/|\/logo\.(svg|png)|spinner/i.test(img.src) &&
    !img.src.endsWith('.svg')
  );
}

function isUserUploadedImage(img) {
  return !!img.closest(
    '[data-message-author-role="user"], form, [data-testid*="composer"], [data-testid*="attachment"], [data-testid*="file-thumbnail"]'
  );
}

// Only images living inside an assistant turn count as generated images
function isInAssistantTurn(img) {
  if (img.closest('[data-message-author-role="assistant"], .agent-turn, [data-turn="assistant"]')) return true;
  const turn = img.closest('article, [data-testid^="conversation-turn"]');
  if (!turn) return img.naturalWidth >= 256; // unknown layout: trust large images outside user/composer
  if (turn.querySelector('[data-message-author-role="user"]')) return false;
  return !!turn.querySelector('[data-message-author-role="assistant"]') ||
         /assistant/i.test(turn.dataset.testid || '') ||
         !!turn.querySelector('.agent-turn');
}

// Resolves the instant a qualifying image loads inside a NEW assistant message
function watchForNewGeneratedImage() {
  const watcher = {};
  watcher.promise = new Promise((resolve, reject) => {
    watcher.resolve = resolve;
    watcher.reject = reject;
  });

  if (!state.isRunning) {
    watcher.cancel = () => {};
    watcher.reject(new Error('Stopped by user'));
    return watcher;
  }

  // scan the whole content area instead of relying on brittle assistant-message selectors
  const scanScope = () => document.querySelector('main') || document.body;

  const seenImageSources = new Set(
    Array.from(scanScope().querySelectorAll('img')).map(img => img.src)
  );
  let finished = false;
  let lastKey = '';
  let stableSince = 0;

  const deadline = setTimeout(() => {
    finish(() => watcher.reject(new Error(`Timeout: no image appeared within 3 minutes (${describe()})`)));
  }, TIMEOUTS.GENERATION_DONE);

  // Poll as well as observe: state can become "ready" without any further DOM mutation
  const poll = setInterval(() => tryResolve(), 500);

  function finish(action) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearInterval(poll);
    observer.disconnect();
    action();
  }

  // Why nothing qualified — shown in the timeout error so failures are diagnosable
  function describe() {
    const imgs = Array.from(scanScope().querySelectorAll('img'));
    const fresh = imgs.filter(img => !seenImageSources.has(img.src) && img.naturalWidth >= 64);
    return `stopBtn=${!!pickFirst(SEL.STOP)}, imgs=${imgs.length}, new>=64px=${fresh.length}, ` +
      `inAssistant=${fresh.filter(isInAssistantTurn).length}, userUploaded=${fresh.filter(isUserUploadedImage).length}`;
  }

  function tryResolve() {
    if (finished) return;
    if (!state.isRunning) { finish(() => watcher.reject(new Error('Stopped by user'))); return; }

    const generating = isChatBusy();
    const generated = collectNew();
    const ready = generated.length > 0 && generated.every(img => img.complete && img.naturalWidth > 0);
    const key = ready ? generated.map(img => img.src).join('|') : '';
    if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
    if (!ready) return;

    // While ChatGPT is still streaming the src may change (preview -> final), so demand a longer
    // stable period; once streaming is over a short settle is enough.
    const needed = generating ? TIMEOUTS.STREAMING_STABLE : TIMEOUTS.IMAGE_SETTLE;
    if (Date.now() - stableSince < needed) return;

    console.debug('[IBG] image ready', { generating, srcs: generated.map(img => img.src) });
    finish(() => watcher.resolve([...new Set(generated.map(img => img.src))]));
  }

  function collectNew() {
    return Array.from(scanScope().querySelectorAll('img')).filter(img =>
      isGeneratedImage(img) && !isUserUploadedImage(img) && isInAssistantTurn(img) && !seenImageSources.has(img.src)
    );
  }

  function attachLoad(img) {
    if (img.complete && img.naturalWidth > 0) tryResolve();
    else {
      img.addEventListener('load',  tryResolve, { once: true });
      img.addEventListener('error', tryResolve, { once: true });
    }
  }

  const observer = new MutationObserver(mutations => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') attachLoad(node);
        else node.querySelectorAll('img').forEach(attachLoad);
      }
      if (mut.type === 'attributes' && mut.target.tagName === 'IMG') attachLoad(mut.target);
    }
    tryResolve();
  });

  observer.observe(document.body, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ['src'],
  });

  watcher.cancel = reason => finish(() => watcher.reject(reason || new Error('Cancelled')));

  tryResolve();
  return watcher;
}
// ==================== DOWNLOAD ====================
function requestDownload(url, filename, sourceKey) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'DOWNLOAD_IMAGE', data: { url, filename, sourceKey } },
      result => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!result?.success) reject(new Error(result?.error || 'Download failed'));
        else resolve(result);
      }
    );
  });
}

async function downloadImage(src, filename) {
  const errors = [];

  // 1) Read the image in the page (has the session auth) and hand it over as a blob URL
  //    (data URLs over ~2 MB are rejected by chrome.downloads; blob URLs have no such limit)
  let blob = null;
  for (let attempt = 0; attempt < 3 && !blob; attempt++) {
    try {
      const response = await fetch(src, { credentials: 'include' });
      if (!response.ok) throw new Error(`Image request failed (${response.status})`);
      blob = await response.blob();
    } catch (err) {
      if (attempt === 2) errors.push(`fetch: ${err.message}`);
      else await sleep(500 * (attempt + 1)); // blob: URLs can briefly be unavailable right after insertion
    }
  }

  if (blob) {
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await requestDownload(blobUrl, filename, `${src}#blob`);
    } catch (err) {
      errors.push(`blob: ${err.message}`);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // 2) Fall back to letting chrome.downloads fetch the http(s) URL itself
  if (/^https?:/i.test(src)) {
    try {
      return await requestDownload(src, filename, src);
    } catch (err) {
      errors.push(`direct: ${err.message}`);
    }
  }

  const message = `Download failed (${errors.join(' | ')})`;
  console.error('[IBG]', message, { src, filename });
  throw new Error(message);
}

// ==================== HELPERS ====================

function buildFullPrompt(raw) {
  const char = (state.settings.characterPrompt || '').trim();
  const bibleNote = state.settings.characterBible
    ? 'Use the uploaded character bible image as the visual reference and keep the character consistent.'
    : '';
  return [bibleNote, char, raw.trim()].filter(Boolean).join('\n\n');
}

function buildFilename(raw, index) {
  const folder = sanitizeDownloadPath(state.settings.downloadFolder) || 'chatgpt-images';

  // Trim at last word boundary within 50 chars so the cut isn't mid-word
  let slug = raw.trim().substring(0, 50);
  const lastSpace = slug.lastIndexOf(' ');
  if (lastSpace > 20) slug = slug.substring(0, lastSpace);

  const sanitized = slug
    .toLowerCase()
    .replace(/[<>:"/\\|?*\r\n]+/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+$/g, '');  // remove trailing underscores left by boundary trim
  const name = sanitized || `scene_${index}`;

  if (state.settings.includeSerial) {
    return `${folder}/${String(index).padStart(3, '0')}_${name}.png`;
  }
  return `${folder}/${name}.png`;
}

function pickFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function hasText(el, text) {
  const actual = el.isContentEditable ? el.innerText || el.textContent : el.value || el.textContent;
  const normalize = value => String(value).replace(/\s+/g, ' ').trim();
  return normalize(actual).includes(normalize(text));
}

function notify(type, data) {
  try {
    chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', type, data });
  } catch { /* popup closed */ }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escapeHtml(str) {
  return str.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}
