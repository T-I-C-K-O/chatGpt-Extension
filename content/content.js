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
    'button[aria-label*="stop" i]',
    'button[aria-label*="Stop" i]',
  ],
  ASSISTANT: [
    '[data-message-author-role="assistant"]',
    '.agent-turn',
    '[data-testid*="conversation-turn"][data-testid*="assistant"]',
  ],
};

const TIMEOUTS = {
  GENERATION_DONE: 180_000,
  IMAGE_SETTLE: 900,
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

    try {
      await generateOne(full, filename);
      state.totalGenerated++;
    } catch (err) {
      state.errorCount++;
      notify('ERROR', { error: err.message, index: state.currentIndex });
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

async function generateOne(fullPrompt, filename) {
  if(!state.isRunning) throw new Error('Generation is not running');
  
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
  while (retries < 15) {
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
    img.naturalWidth  >= 100 &&
    img.naturalHeight >= 100 &&
    !!img.src &&
    !/\/assets\/|logo|avatar|spinner/i.test(img.src) &&
    !img.src.endsWith('.svg')
  );
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

  const seenImageSources = new Set(
    getAllAssistantMessages()
      .flatMap(message => Array.from(message.querySelectorAll('img')))
      .map(img => img.src)
  );
  let settleTimer = null;
  let finished = false;

  const deadline = setTimeout(() => {
    finish(() => watcher.reject(new Error('Timeout: no image appeared within 3 minutes')));
  }, TIMEOUTS.GENERATION_DONE);

  function finish(action) {
    if (finished) return;
    finished = true;
    if (settleTimer) clearTimeout(settleTimer);
    clearTimeout(deadline);
    observer.disconnect();
    action();
  }

  function tryResolve() {
    if (finished) return;
    if (!state.isRunning) { finish(() => watcher.reject(new Error('Stopped by user'))); return; }

    const messages = getAllAssistantMessages();
    const lastMsg = messages.at(-1);
    if (!lastMsg) return;

    const imgs = messages.flatMap(message => Array.from(message.querySelectorAll('img')));
    const generated = imgs.filter(img =>
      isGeneratedImage(img) && !seenImageSources.has(img.src)
    );
    if (!generated.length || !generated.every(img => img.complete && img.naturalWidth > 0)) return;

    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      finish(() => watcher.resolve([...new Set(generated.map(img => img.src))]));
    }, TIMEOUTS.IMAGE_SETTLE);
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

  observer.observe(document.querySelector('main') || document.body, {
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
async function downloadImage(src, filename) {
  // Resolve the temporary/page-scoped URL while the ChatGPT page can access it.
  let downloadUrl = src;
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);

    const blob = await response.blob();
    downloadUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not prepare image for download'));
      reader.readAsDataURL(blob);
    });
  } catch {
    // Signed remote URLs can still be downloaded when page fetch is blocked by CORS.
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'DOWNLOAD_IMAGE', data: { url: downloadUrl, filename } },
      result => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!result?.success) reject(new Error(result?.error || 'Download failed'));
        else resolve(result);
      }
    );
  });
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
  const folder = state.settings.downloadFolder || 'chatgpt-images';

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

  if (state.settings.includeSerial) {
    return `${folder}/${String(index).padStart(3, '0')}_${sanitized}.png`;
  }
  return `${folder}/${sanitized}.png`;
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
