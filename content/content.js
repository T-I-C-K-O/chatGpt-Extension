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
      startGeneration(msg.data)
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true; // keep channel open

    case 'STOP_GENERATION':
      state.isRunning = false;
      sendResponse({ success: true });
      break;

    case 'REGENERATE_LAST':
      if (!state.lastFullPrompt) {
        sendResponse({ success: false, error: 'Nothing to regenerate' });
      } else {
        regenerateLast()
          .then(() => sendResponse({ success: true }))
          .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
      }
      break;
  }
});

// ==================== START ====================
async function startGeneration(data) {
  const prompts = (data.prompts || []).filter(p => p.trim());
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
      await sleep(state.settings.delay || 4000);
    }
  }

  state.isRunning = false;
  notify('COMPLETE', {
    totalGenerated: state.totalGenerated,
    total:          state.queue.length,
    errorCount:     state.errorCount,
  });
}

// ==================== SINGLE GENERATION ====================
async function generateOne(fullPrompt, filename) {
  await typeInChatGPT(fullPrompt);
  await sleep(400);
  await clickSend();

  // Resolves the exact moment a generated image finishes loading — zero static waits
  const srcs = await watchForNewGeneratedImage();

  if (state.settings.autoDownload !== false) {
    for (let i = 0; i < srcs.length; i++) {
      const fname = srcs.length > 1 ? filename.replace(/\.png$/, `_${i + 1}.png`) : filename;
      await downloadImage(srcs[i], fname);
      notify('SAVED', { filename: fname });
    }
  }
}

// ==================== CHATGPT DOM INTERACTION ====================
async function typeInChatGPT(text) {
  const input = pickFirst(SEL.INPUT);
  if (!input) throw new Error('ChatGPT input field not found. Make sure you are on the ChatGPT page and it is fully loaded.');

  input.click();
  input.focus();
  await sleep(200);

  // Clear existing content
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await sleep(80);

  // Primary: execCommand — works for most contenteditable/ProseMirror setups
  const ok = document.execCommand('insertText', false, text);

  // Fallback A: ClipboardEvent paste (triggers React synthetic events)
  if (!ok || !hasText(input, text)) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch { /* ignore */ }
  }

  // Fallback B: direct innerHTML + React event trick
  if (!hasText(input, text)) {
    if (input.contentEditable === 'true') {
      input.innerHTML = `<p>${escapeHtml(text)}</p>`;
    } else {
      // textarea
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(input, text) : (input.value = text);
    }
    input.dispatchEvent(new InputEvent('input',  { bubbles: true, data: text, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  await sleep(350);
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
  return new Promise((resolve, reject) => {
    if (!state.isRunning) { reject(new Error('Stopped by user')); return; }

    const baselineCount = countAssistantMessages();

    const deadline = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timeout: no image appeared within 3 minutes'));
    }, TIMEOUTS.GENERATION_DONE);

    function done(srcs) {
      clearTimeout(deadline);
      observer.disconnect();
      resolve(srcs);
    }

    function tryResolve() {
      if (!state.isRunning) {
        clearTimeout(deadline);
        observer.disconnect();
        reject(new Error('Stopped by user'));
        return;
      }
      if (countAssistantMessages() <= baselineCount) return;
      const lastMsg = getLastAssistantMessage();
      if (!lastMsg) return;
      const imgs = Array.from(lastMsg.querySelectorAll('img')).filter(isGeneratedImage);
      if (imgs.length) done(imgs.map(img => img.src));
    }

    function attachLoad(img) {
      if (img.complete && img.naturalWidth > 0) {
        tryResolve();
      } else {
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
        if (mut.type === 'attributes' && mut.target.tagName === 'IMG') {
          attachLoad(mut.target);
        }
      }
      tryResolve();
    });

    observer.observe(document.body, {
      childList:       true,
      subtree:         true,
      attributes:      true,
      attributeFilter: ['src'],
    });

    tryResolve(); // handle image already rendered before observer attaches
  });
}

// ==================== DOWNLOAD ====================
async function downloadImage(src, filename) {
  // OpenAI DALL-E image URLs already carry SAS auth tokens — pass directly.
  // Skipping fetch+base64 eliminates 2-4 s of encode/decode overhead per image.
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'DOWNLOAD_IMAGE', data: { url: src, filename } },
      res => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      }
    );
  });
}

// ==================== HELPERS ====================

function buildFullPrompt(raw) {
  const char = (state.settings.characterPrompt || '').trim();
  return char ? `${char}\n\n${raw.trim()}` : raw.trim();
}

function buildFilename(raw, index) {
  const folder    = state.settings.downloadFolder || 'chatgpt-images';
  const sanitized = raw.substring(0, 60)
    .replace(/[<>:"/\\|?*\r\n]+/g, '')
    .trim()
    .replace(/\s+/g, '_');

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
  const sample = text.substring(0, 15);
  return (el.textContent || el.value || '').includes(sample);
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
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
