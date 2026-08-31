'use strict';

// ==================== STATE ====================
let activeTabId = null;
let isGenerating = false;
let totalInQueue = 0;
let queueItems   = []; // { prompt, status: 'pending'|'running'|'success'|'failed', error }

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await checkStatus();
  setupEventListeners();
  setInterval(checkStatus, 4000);
});

// ==================== SETTINGS ====================

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');

  if (settings.characterEnabled !== undefined) {
    document.getElementById('characterToggle').checked = settings.characterEnabled;
    toggleCharacterSection(settings.characterEnabled);
  }
  if (settings.characterPrompt) {
    document.getElementById('characterPrompt').value = settings.characterPrompt;
  }
  if (settings.prompts) {
    document.getElementById('promptQueue').value = settings.prompts;
    updateQueueCount();
  }
  if (settings.downloadFolder) {
    document.getElementById('folderName').value = settings.downloadFolder;
  }
  if (settings.delay !== undefined) {
    document.getElementById('delay').value = settings.delay;
  }
  if (settings.includeSerial !== undefined) {
    document.getElementById('serialToggle').checked = settings.includeSerial;
  }
  if (settings.autoDownload !== undefined) {
    document.getElementById('autoDownloadToggle').checked = settings.autoDownload;
  }
}

function collectSettings() {
  return {
    characterEnabled: document.getElementById('characterToggle').checked,
    characterPrompt: document.getElementById('characterPrompt').value,
    prompts: document.getElementById('promptQueue').value,
    downloadFolder: document.getElementById('folderName').value.trim() || 'chatgpt-images',
    delay: Math.max(2, parseInt(document.getElementById('delay').value) || 4),
    includeSerial: document.getElementById('serialToggle').checked,
    autoDownload: document.getElementById('autoDownloadToggle').checked,
  };
}

const saveSettingsDebounced = debounce(() => {
  chrome.storage.local.set({ settings: collectSettings() });
}, 800);

// ==================== STATUS ====================

async function checkStatus() {
  setStatusUI('checking', 'Checking connection...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { setStatusUI('disconnected', 'No active tab'); return; }

    activeTabId = tab.id;
    const url = tab.url || '';
    const onChatGPT = url.includes('chatgpt.com') || url.includes('chat.openai.com');

    if (!onChatGPT) {
      setStatusUI('disconnected', 'Not on ChatGPT');
      document.getElementById('goToBtn').style.display = 'flex';
      setControlsEnabled(false);
      return;
    }

    document.getElementById('goToBtn').style.display = 'none';

    let pong = await sendToTab({ action: 'PING' }).catch(() => null);

    // Content script not yet in this tab — inject it programmatically
    if (!pong || !pong.pong) {
      setStatusUI('checking', 'Injecting script…');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          files: ['content/content.js'],
        });
        await sleep(400);
        pong = await sendToTab({ action: 'PING' }).catch(() => null);
      } catch { /* scripting blocked on this page */ }
    }

    if (pong && pong.pong) {
      setStatusUI('connected', 'Connected · ChatGPT ready');
      setControlsEnabled(!isGenerating);

      // Sync running state from content script
      const status = await sendToTab({ action: 'GET_STATUS' }).catch(() => null);
      if (status && status.isRunning !== isGenerating) {
        isGenerating = status.isRunning;
        syncGeneratingUI(isGenerating);
        if (isGenerating) {
          showProgress(true);
          updateProgressBar(status.currentIndex, status.total);
        }
      }
    } else {
      setStatusUI('disconnected', 'Reload the ChatGPT tab (Ctrl+R) then retry');
      setControlsEnabled(false);
    }
  } catch {
    setStatusUI('disconnected', 'Cannot access tab');
    setControlsEnabled(false);
  }
}

function setStatusUI(type, text) {
  const dot = document.getElementById('statusDot');
  dot.className = `status-dot ${type}`;
  document.getElementById('statusText').textContent = text;
}

function setControlsEnabled(enabled) {
  document.getElementById('startBtn').disabled = !enabled;
  document.getElementById('regenBtn').disabled = !enabled;
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
  // Character toggle
  document.getElementById('characterToggle').addEventListener('change', e => {
    toggleCharacterSection(e.target.checked);
    saveSettingsDebounced();
  });

  // Prompt textarea
  document.getElementById('promptQueue').addEventListener('input', () => {
    updateQueueCount();
    saveSettingsDebounced();
  });

  // File upload
  document.getElementById('uploadTxtBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });
  document.getElementById('fileInput').addEventListener('change', handleFileUpload);

  // All settings fields
  ['folderName', 'delay', 'characterPrompt'].forEach(id => {
    document.getElementById(id).addEventListener('input', saveSettingsDebounced);
  });
  ['serialToggle', 'autoDownloadToggle'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsDebounced);
  });

  // Control buttons
  document.getElementById('startBtn').addEventListener('click', startGeneration);
  document.getElementById('stopBtn').addEventListener('click', stopGeneration);
  document.getElementById('regenBtn').addEventListener('click', regenerateLast);

  // Go to ChatGPT
  document.getElementById('goToBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chatgpt.com' });
  });

  // Progress updates from content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'PROGRESS_UPDATE') {
      handleProgressUpdate(message);
    }
  });
}

// ==================== QUEUE ====================

function updateQueueCount() {
  const lines = document.getElementById('promptQueue').value
    .split('\n')
    .filter(l => l.trim());
  totalInQueue = lines.length;
  document.getElementById('queueCount').textContent = totalInQueue;
}

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = evt => {
    document.getElementById('promptQueue').value = evt.target.result;
    updateQueueCount();
    saveSettingsDebounced();
    showToast(`Loaded ${totalInQueue} prompts from file`, 'success');
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ==================== GENERATION ====================

async function startGeneration() {
  const s = collectSettings();
  const prompts = s.prompts.split('\n').filter(p => p.trim());

  if (prompts.length === 0) {
    showToast('Add at least one prompt to the queue', 'error');
    return;
  }

  const payload = {
    prompts,
    characterPrompt: s.characterEnabled ? s.characterPrompt : '',
    downloadFolder: s.downloadFolder,
    delay: s.delay * 1000,
    includeSerial: s.includeSerial,
    autoDownload: s.autoDownload,
  };

  try {
    await sendToTab({ action: 'START_GENERATION', data: payload });
    isGenerating = true;
    syncGeneratingUI(true);
    showProgress(true);
    updateProgressBar(0, prompts.length);
    document.getElementById('progressText').textContent = 'Starting generation…';
    initQueueStatus(prompts);
  } catch (err) {
    showToast('Failed to start: ' + err.message, 'error');
  }
}

async function stopGeneration() {
  try {
    await sendToTab({ action: 'STOP_GENERATION' });
    isGenerating = false;
    syncGeneratingUI(false);
    // Mark any still-running items as failed
    queueItems.forEach((item, i) => {
      if (item.status === 'running' || item.status === 'pending') {
        queueItems[i].status = item.status === 'running' ? 'failed' : 'pending';
      }
    });
    renderQueueStatus();
    showToast('Generation stopped', 'info');
  } catch (err) {
    showToast('Stop failed: ' + err.message, 'error');
  }
}

async function regenerateLast() {
  try {
    const res = await sendToTab({ action: 'REGENERATE_LAST' });
    if (res && res.success) {
      showToast('Regenerating last image…', 'info');
      addLog('info', 'Regenerating last prompt');
    } else {
      showToast('Nothing to regenerate yet', 'error');
    }
  } catch {
    showToast('Nothing to regenerate yet', 'error');
  }
}

// ==================== PROGRESS ====================

function handleProgressUpdate(message) {
  const { type, data } = message;

  switch (type) {
    case 'STARTED':
      setQueueItemStatus(data.currentIndex, 'running');
      document.getElementById('progressText').textContent =
        `Generating [${data.currentIndex + 1}]: ${data.prompt.substring(0, 45)}…`;
      break;

    case 'PROGRESS':
      updateProgressBar(data.currentIndex, data.total);
      document.getElementById('progressText').textContent =
        `${data.totalGenerated} saved · ${data.errorCount} errors`;
      break;

    case 'SAVED':
      // Find the running item and mark it done
      {
        const idx = queueItems.findIndex(i => i.status === 'running');
        if (idx !== -1) setQueueItemStatus(idx, 'success');
      }
      break;

    case 'ERROR':
      setQueueItemStatus(data.index, 'failed', data.error);
      document.getElementById('progressText').textContent =
        `Error on item ${data.index + 1} — continuing…`;
      break;

    case 'RETRY_SUCCESS':
      setQueueItemStatus(data.index, 'success');
      break;

    case 'RETRY_ERROR':
      setQueueItemStatus(data.index, 'failed', data.error);
      break;

    case 'COMPLETE':
      isGenerating = false;
      syncGeneratingUI(false);
      updateProgressBar(data.totalGenerated, data.total || data.totalGenerated);
      document.getElementById('progressText').textContent =
        `✓ Done — ${data.totalGenerated} saved, ${data.errorCount} failed`;
      showToast(`Complete! ${data.totalGenerated} images saved.`, 'success');
      break;
  }
}

function updateProgressBar(current, total) {
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
  document.getElementById('progressFill').style.width = `${pct}%`;
  document.getElementById('progressCounter').textContent = `${current} / ${total}`;
}

function showProgress(visible) {
  document.getElementById('progressSection').style.display = visible ? 'block' : 'none';
}

// ==================== QUEUE STATUS ====================

function initQueueStatus(prompts) {
  queueItems = prompts.map(p => ({ prompt: p.trim(), status: 'pending', error: null }));
  renderQueueStatus();
  updateQsSummary();
}

function setQueueItemStatus(index, status, error = null) {
  if (index < 0 || index >= queueItems.length) return;
  queueItems[index].status = status;
  queueItems[index].error  = error;
  renderQueueStatus();
  updateQsSummary();
  const el = document.querySelector(`.qs-item[data-index="${index}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderQueueStatus() {
  const list = document.getElementById('queueStatusList');
  list.innerHTML = '';

  if (!queueItems.length) {
    list.innerHTML = '<div class="qs-empty">Start generation to track each prompt here.</div>';
    return;
  }

  queueItems.forEach((item, i) => {
    const label = { pending: 'Pending', running: 'Generating…', success: 'Done', failed: 'Failed' }[item.status];
    const retryBtn = item.status === 'failed'
      ? `<button class="qs-retry" data-index="${i}">↺ Retry</button>`
      : '';
    const el = document.createElement('div');
    el.className = `qs-item qs-${item.status}`;
    el.dataset.index = i;
    el.innerHTML =
      `<span class="qs-num">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="qs-dot"></span>` +
      `<span class="qs-text" title="${escapeHtml(item.prompt)}">${escapeHtml(item.prompt.length > 52 ? item.prompt.substring(0, 52) + '…' : item.prompt)}</span>` +
      `<span class="qs-label">${label}</span>` +
      retryBtn;
    list.appendChild(el);
  });

  list.querySelectorAll('.qs-retry').forEach(btn => {
    btn.addEventListener('click', () => retryQueueItem(parseInt(btn.dataset.index)));
  });
}

function updateQsSummary() {
  if (!queueItems.length) { document.getElementById('qsStats').textContent = ''; return; }
  const done   = queueItems.filter(i => i.status === 'success').length;
  const failed = queueItems.filter(i => i.status === 'failed').length;
  const left   = queueItems.filter(i => i.status === 'pending' || i.status === 'running').length;
  document.getElementById('qsStats').textContent =
    `${done}✓  ${failed}✗  ${left} left`;
}

async function retryQueueItem(index) {
  const item = queueItems[index];
  if (!item) return;
  setQueueItemStatus(index, 'running');
  try {
    await sendToTab({ action: 'REGENERATE_INDEX', data: { index, prompt: item.prompt } });
  } catch (err) {
    setQueueItemStatus(index, 'failed', err.message);
    showToast('Retry failed: ' + err.message, 'error');
  }
}

// ==================== UI HELPERS ====================

function syncGeneratingUI(running) {
  document.getElementById('startBtn').style.display = running ? 'none' : 'flex';
  document.getElementById('stopBtn').style.display  = running ? 'flex' : 'none';
  document.getElementById('regenBtn').disabled = running;
}

function toggleCharacterSection(show) {
  document.getElementById('characterSection').style.display = show ? 'block' : 'none';
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ==================== COMMS ====================

function sendToTab(message) {
  return new Promise((resolve, reject) => {
    if (!activeTabId) { reject(new Error('No active tab')); return; }
    chrome.tabs.sendMessage(activeTabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ==================== UTILS ====================

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
