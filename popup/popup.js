// ============================================================
// SmartBot Popup Controller
// ============================================================

let steps = [];
let isRecording = false;
let isPlaying = false;
let editingStepId = null;

// ── DOM refs ──────────────────────────────────────────────
const btnRecord      = document.getElementById('btn-record');
const btnStop        = document.getElementById('btn-stop');
const btnPlayCurrent = document.getElementById('btn-play-current');
const btnPlayAll     = document.getElementById('btn-play-all');
const btnStopPlay    = document.getElementById('btn-stop-play');   // NEW
const chkCloseTab    = document.getElementById('chk-close-tab');   // NEW
const btnClear       = document.getElementById('btn-clear');
const stepsList      = document.getElementById('steps-list');
const stepCount      = document.getElementById('step-count');
const statusBadge    = document.getElementById('status-badge');
const speedSlider    = document.getElementById('speed-slider');
const speedVal       = document.getElementById('speed-val');
const editModal      = document.getElementById('edit-modal');
const modalEditor    = document.getElementById('modal-editor');
const modalBadge     = document.getElementById('modal-badge');
const modalFieldLabel= document.getElementById('modal-field-label');
const editSave       = document.getElementById('edit-save');
const editCancel     = document.getElementById('edit-cancel');
const modalCloseX    = document.getElementById('modal-close-x');

// ── Helpers ───────────────────────────────────────────────
function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${cls}`;
}

function updateUI() {
  btnRecord.disabled    = isRecording || isPlaying;
  btnStop.disabled      = !isRecording;
  btnPlayCurrent.disabled = isPlaying || steps.length === 0;
  btnPlayAll.disabled   = isPlaying || steps.length === 0;
  btnStopPlay.disabled  = !isPlaying;   // NEW: only enabled while playing
  btnClear.disabled     = isRecording || isPlaying;
  stepCount.textContent = steps.length;

  if (isRecording) {
    btnRecord.classList.add('active');
    setStatus('● REC', 'recording');
  } else if (isPlaying) {
    btnRecord.classList.remove('active');
    setStatus('▶ Playing', 'playing');
  } else {
    btnRecord.classList.remove('active');
    setStatus(steps.length > 0 ? `${steps.length} steps` : 'Idle',
              steps.length > 0 ? 'done' : 'idle');
  }

  renderSteps();
}

// ── Action type → badge ───────────────────────────────────
function getActionBadge(action) {
  const map = {
    type:          { cls: 'badge-type',   label: 'TYPE'   },
    textarea:      { cls: 'badge-type',   label: 'TYPE'   },
    click:         { cls: 'badge-click',  label: 'CLICK'  },
    click_button:  { cls: 'badge-button', label: 'BTN'    },
    select:        { cls: 'badge-select', label: 'SELECT' },
    'custom-select':{ cls:'badge-select', label: 'SELECT' },
    scroll:        { cls: 'badge-scroll', label: 'SCROLL' },
    checkbox:      { cls: 'badge-check',  label: 'CHECK'  },
    radio:         { cls: 'badge-check',  label: 'RADIO'  },
    link:          { cls: 'badge-click',  label: 'LINK'   },
  };
  return map[action] || { cls: 'badge-click', label: action?.toUpperCase() || '?' };
}

// Which step types are editable and what they show
function isEditable(action) {
  return ['type', 'textarea', 'select', 'custom-select', 'checkbox', 'radio', 'click_button', 'scroll'].includes(action);
}

// ── Render steps list ─────────────────────────────────────
function renderSteps() {
  if (steps.length === 0) {
    stepsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎬</div>
        <div>No steps recorded yet</div>
        <div class="empty-sub">Click Start Recording and interact with the page</div>
      </div>`;
    return;
  }

  stepsList.innerHTML = '';
  steps.forEach((step, i) => {
    const badge    = getActionBadge(step.action);
    const valueStr = getDisplayValue(step);
    const editable = isEditable(step.action);
    const card     = document.createElement('div');
    card.className = 'step-card';
    card.dataset.id = step.id;

    card.innerHTML = `
      <span class="step-num">${i + 1}</span>
      <div class="step-body">
        <div class="step-action-row">
          <span class="step-badge ${badge.cls}">${badge.label}</span>
          <span class="step-label ${editable ? 'step-label-editable' : ''}" title="${step.label || ''}" data-id="${step.id}">${step.label || step.action}</span>
        </div>
        ${valueStr ? `<div class="step-value${editable ? ' step-value-editable' : ''}"
                           title="${valueStr}"
                           data-id="${step.id}"
                           data-editable="${editable}">${valueStr}</div>` : ''}
      </div>
      <div class="step-actions">
        ${editable ? `<button class="step-btn edit-btn" data-id="${step.id}" title="Edit step">✎</button>` : ''}
        <button class="step-btn del del-btn" data-id="${step.id}" title="Delete">✕</button>
      </div>`;
    stepsList.appendChild(card);
  });

  stepsList.querySelectorAll('.del-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteStep(btn.dataset.id)));
  stepsList.querySelectorAll('.edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEdit(btn.dataset.id)));
  stepsList.querySelectorAll('.step-value-editable').forEach(el =>
    el.addEventListener('click', () => openEdit(el.dataset.id)));
  stepsList.querySelectorAll('.step-label-editable').forEach(el =>
    el.addEventListener('click', () => openEdit(el.dataset.id)));
}

function getDisplayValue(step) {
  switch (step.action) {
    case 'type':
    case 'textarea':      return step.value || '';
    case 'select':        return step.selectedText || step.value || '';
    case 'custom-select': return step.selectedText || step.value || '';
    case 'scroll':        return `${step.direction} → ${step.scrollY}px`;
    case 'click_button':  return step.buttonText || '';
    case 'checkbox':      return step.checked ? '☑ Checked' : '☐ Unchecked';
    case 'radio':         return step.value || '';
    default:              return '';
  }
}

// ── CRUD ──────────────────────────────────────────────────
function deleteStep(id) {
  steps = steps.filter(s => s.id !== id);
  send({ type: 'UPDATE_STEPS', steps });
  updateUI();
}

// ── Rich Edit Modal ───────────────────────────────────────
// Builds the correct editor UI for every step type
// so that what you save replays identically.

function buildEditor(step) {
  const action = step.action;

  // ── text / textarea ──────────────────────────────────
  if (action === 'type' || action === 'textarea') {
    return `
      <div class="editor-group">
        <label class="editor-label">Value to type</label>
        <textarea id="ed-value" class="modal-textarea" rows="3"
                  placeholder="Enter text to type...">${escHtml(step.value || '')}</textarea>
        <div class="editor-hint">This exact text will be typed into the field on replay.</div>
      </div>`;
  }

  // ── native <select> ──────────────────────────────────
  if (action === 'select') {
    const opts = step.allOptions || [];
    if (opts.length > 0) {
      const optionsHtml = opts.map(o =>
        `<option value="${escAttr(o.value)}" ${o.text === step.selectedText || o.value === step.value ? 'selected' : ''}>${escHtml(o.text)}</option>`
      ).join('');
      return `
        <div class="editor-group">
          <label class="editor-label">Select option</label>
          <select id="ed-select" class="modal-select">${optionsHtml}</select>
          <div class="editor-hint">Choose the option that will be selected on replay.</div>
          <button id="btn-inline-update" class="btn-inline-update" type="button">✓ Update</button>
        </div>`;
    }
    // No allOptions recorded — fall back to text
    return `
      <div class="editor-group">
        <label class="editor-label">Option text</label>
        <input id="ed-value" class="modal-input" type="text"
               value="${escAttr(step.selectedText || step.value || '')}"
               placeholder="Option text or value...">
        <div class="editor-hint">Must match an option text or value in the dropdown.</div>
      </div>`;
  }

  // ── custom dropdown (div/React/MUI/etc.) ─────────────
  if (action === 'custom-select') {
    return `
      <div class="editor-group">
        <label class="editor-label">Option to select</label>
        <input id="ed-value" class="modal-input" type="text"
               value="${escAttr(step.selectedText || step.value || '')}"
               placeholder="Option text to match...">
        <div class="editor-hint">Text that matches the dropdown option (partial match allowed).</div>
      </div>`;
  }

  // ── checkbox ─────────────────────────────────────────
  if (action === 'checkbox') {
    return `
      <div class="editor-group">
        <label class="editor-label">Checkbox state</label>
        <div class="toggle-row">
          <label class="toggle-switch">
            <input type="checkbox" id="ed-checked" ${step.checked ? 'checked' : ''}>
            <span class="toggle-track">
              <span class="toggle-thumb"></span>
            </span>
          </label>
          <span id="toggle-label" class="toggle-label">${step.checked ? 'Checked ☑' : 'Unchecked ☐'}</span>
        </div>
        <div class="editor-hint">The checkbox will be set to this state on replay.</div>
      </div>`;
  }

  // ── radio ────────────────────────────────────────────
  if (action === 'radio') {
    return `
      <div class="editor-group">
        <label class="editor-label">Radio value</label>
        <input id="ed-value" class="modal-input" type="text"
               value="${escAttr(step.value || '')}"
               placeholder="Radio option value...">
        <div class="editor-hint">The value attribute of the radio button to select.</div>
      </div>`;
  }

  // ── click_button ──────────────────────────────────────
  if (action === 'click_button') {
    return `
      <div class="editor-group">
        <label class="editor-label">Button text to match</label>
        <input id="ed-value" class="modal-input" type="text"
               value="${escAttr(step.buttonText || step.label || '')}"
               placeholder="Button text...">
        <div class="editor-hint">Replay will click the button whose text matches this value.</div>
      </div>`;
  }

  // ── scroll ────────────────────────────────────────────
  if (action === 'scroll') {
    return `
      <div class="editor-group">
        <label class="editor-label">Scroll position (px from top)</label>
        <input id="ed-scroll" class="modal-input" type="number"
               value="${step.scrollY || 0}" min="0" step="50"
               placeholder="e.g. 500">
        <div class="editor-hint">Page will scroll to this Y position on replay.</div>
      </div>`;
  }

  return `<div class="editor-hint">No editable parameters for this step type.</div>`;
}

function openEdit(id) {
  const step = steps.find(s => s.id === id);
  if (!step) return;
  editingStepId = id;

  const badge = getActionBadge(step.action);
  modalBadge.className = `step-badge ${badge.cls}`;
  modalBadge.textContent = badge.label;
  modalFieldLabel.value = step.label || step.action;

  modalEditor.innerHTML = buildEditor(step);

  // Wire up inline Update button for native <select> dropdown
  if (step.action === 'select') {
    const edSel = document.getElementById('ed-select');
    const btnUpdate = document.getElementById('btn-inline-update');
    if (edSel && btnUpdate) {
      // Always show the Update button — user may re-confirm same value or
      // the button was already visible; do NOT hide it based on value comparison.
      btnUpdate.addEventListener('click', () => collectAndSave());
    }
  }

  // Wire up live label for checkbox toggle
  if (step.action === 'checkbox') {
    const chk = document.getElementById('ed-checked');
    const lbl = document.getElementById('toggle-label');
    if (chk && lbl) {
      chk.addEventListener('change', () => {
        lbl.textContent = chk.checked ? 'Checked ☑' : 'Unchecked ☐';
      });
    }
  }

  editModal.classList.remove('hidden');

  // Focus the first interactive element
  const first = modalEditor.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 60);
}

function collectAndSave() {
  const step = steps.find(s => s.id === editingStepId);
  if (!step) { closeModal(); return; }

  // ── Save the (possibly edited) label name ───────────────
  // The label is used by the label-based auto-detector during replay.
  // Editing it lets you "teach" the bot to find the right element.
  const newLabel = document.getElementById('modal-field-label')?.value?.trim();
  if (newLabel) step.label = newLabel;

  const action = step.action;

  if (action === 'type' || action === 'textarea') {
    step.value = document.getElementById('ed-value')?.value ?? step.value;
  }

  else if (action === 'select') {
    const sel = document.getElementById('ed-select');
    const inp = document.getElementById('ed-value');
    if (sel) {
      // Sync both value AND selectedText so executor can match either way
      const chosen = sel.options[sel.selectedIndex];
      step.value        = chosen.value;
      step.selectedText = chosen.text;
    } else if (inp) {
      step.selectedText = inp.value;
      step.value        = inp.value;
    }
  }

  else if (action === 'custom-select') {
    const inp = document.getElementById('ed-value');
    if (inp) {
      step.selectedText = inp.value;
      step.value        = inp.value;
    }
  }

  else if (action === 'checkbox') {
    const chk = document.getElementById('ed-checked');
    if (chk) step.checked = chk.checked;
  }

  else if (action === 'radio') {
    const inp = document.getElementById('ed-value');
    if (inp) step.value = inp.value;
  }

  else if (action === 'click_button') {
    const inp = document.getElementById('ed-value');
    if (inp) {
      step.buttonText = inp.value;
      step.label      = inp.value; // keep label in sync for display + findByLabel
    }
  }

  else if (action === 'scroll') {
    const inp = document.getElementById('ed-scroll');
    if (inp) {
      const newY = parseInt(inp.value, 10);
      if (!isNaN(newY)) {
        step.scrollY = newY;
        step.direction = newY > (step.scrollY || 0) ? 'down' : 'up';
        step.label = `Scroll to ${newY}px`;
      }
    }
  }

  send({ type: 'UPDATE_STEPS', steps });
  updateUI();
  closeModal();
}

function closeModal() {
  editModal.classList.add('hidden');
  editingStepId = null;
  modalEditor.innerHTML = '';
}

editSave.addEventListener('click', collectAndSave);
editCancel.addEventListener('click', closeModal);
modalCloseX.addEventListener('click', closeModal);

// Keyboard shortcuts inside modal
editModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); return; }
  // Ctrl+Enter or Enter on non-textarea saves
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { collectAndSave(); return; }
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { collectAndSave(); }
});

// Close on backdrop click
editModal.addEventListener('click', (e) => {
  if (e.target === editModal) closeModal();
});

// ── Button actions ────────────────────────────────────────
btnRecord.addEventListener('click', async () => {
  await send({ type: 'START_RECORDING' });
  isRecording = true;
  steps = [];
  updateUI();
});

btnStop.addEventListener('click', async () => {
  const res = await send({ type: 'STOP_RECORDING' });
  isRecording = false;
  if (res?.steps) steps = res.steps;
  updateUI();
});

btnPlayCurrent.addEventListener('click', async () => {
  if (!steps.length) return;
  isPlaying = true;
  updateUI();
  await send({ type: 'PLAY_CURRENT_TAB' });
  isPlaying = false;
  updateUI();
});

btnPlayAll.addEventListener('click', async () => {
  if (!steps.length) return;
  isPlaying = true;
  updateUI();
  // Result is handled via broadcast events below (PLAYBACK_ALL_DONE)
  send({ type: 'PLAY_ALL_TABS' });
});

// ── NEW: Stop Playback button ─────────────────────────────
btnStopPlay.addEventListener('click', async () => {
  await send({ type: 'STOP_PLAYBACK' });
  setStatus('⏹ Stopped', 'idle');
  isPlaying = false;
  updateUI();
});

// ── NEW: Close Tab toggle ─────────────────────────────────
chkCloseTab.addEventListener('change', () => {
  send({ type: 'SET_CLOSE_TAB', enabled: chkCloseTab.checked });
});

btnClear.addEventListener('click', async () => {
  if (!confirm('Clear all recorded steps?')) return;
  steps = [];
  await send({ type: 'CLEAR_STEPS' });
  updateUI();
});

// ── Speed slider ──────────────────────────────────────────
speedSlider.addEventListener('input', () => {
  const v = parseInt(speedSlider.value);
  const labels = { 200: '⚡ Turbo', 400: '🚀 Fast', 600: '✨ Normal', 800: '🐇 Steady', 1000: '🐢 Careful', 1400: '🔍 Slow', 2000: '🐌 Debug' };
  const closest = Object.keys(labels).reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
  speedVal.textContent = labels[closest] || `${v}ms`;
  send({ type: 'SET_SPEED', speed: v });
});

// ── Live updates from background ─────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STEP_ADDED') {
    send({ type: 'GET_STATE' }).then(res => {
      if (res?.state?.recordedSteps) {
        steps = res.state.recordedSteps;
        stepCount.textContent = steps.length;
        renderSteps();
        stepsList.scrollTop = stepsList.scrollHeight;
      }
    });
  }

  // NEW: show which tab is being executed
  if (msg.type === 'PLAYBACK_TAB_START') {
    const { title, index, total } = msg;
    const short = title ? title.slice(0, 22) + (title.length > 22 ? '…' : '') : 'Tab';
    setStatus(`▶ ${index + 1}/${total}: ${short}`, 'playing');
  }

  // NEW: tab closed notification
  if (msg.type === 'TAB_CLOSED') {
    // Status already updates via TAB_START of next tab or ALL_DONE
  }

  // NEW: user stopped playback mid-run
  if (msg.type === 'PLAYBACK_STOPPED') {
    isPlaying = false;
    const ok    = (msg.results || []).filter(r => r.success).length;
    const total = (msg.results || []).length;
    setStatus(`⏹ Stopped: ${ok}/${total}`, 'idle');
    updateUI();
  }

  // NEW: all tabs done
  if (msg.type === 'PLAYBACK_ALL_DONE') {
    isPlaying = false;
    const ok    = (msg.results || []).filter(r => r.success).length;
    const total = (msg.results || []).length;
    setStatus(`✓ Done: ${ok}/${total} tabs`, 'done');
    updateUI();
    setTimeout(updateUI, 4000);
  }
});

// ── Escape helpers ────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(s) { return escHtml(s); }

// ── Init ──────────────────────────────────────────────────
async function init() {
  const res = await send({ type: 'GET_STATE' });
  if (res?.state) {
    isRecording = res.state.recording;
    isPlaying   = res.state.playing;
    steps       = res.state.recordedSteps || [];
    if (res.state.playbackSpeed) {
      speedSlider.value = res.state.playbackSpeed;
      speedSlider.dispatchEvent(new Event('input'));
    }
    // NEW: restore close-tab toggle
    if (chkCloseTab) chkCloseTab.checked = !!res.state.closeTabAfterDone;
  }
  updateUI();
}

init();

// ══════════════════════════════════════════════════════════
// v9: MACRO-ANALYZER UI HOOKS
// ══════════════════════════════════════════════════════════

// ── Scan Page button ──────────────────────────────────────
const btnScanPage   = document.getElementById('btn-scan-page');
const scanResults   = document.getElementById('scan-results');
const chkDebugMode  = document.getElementById('chk-debug-mode');

if (btnScanPage) {
  btnScanPage.addEventListener('click', async () => {
    btnScanPage.disabled = true;
    btnScanPage.querySelector('span:last-child').textContent = 'Scanning…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      // Inject macro-analyzer if not already there
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => typeof window.SmartMacroAnalyzer !== 'undefined',
      }).then(async ([result]) => {
        if (!result.result) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/macro-analyzer.js', 'content/label-scanner.js', 'content/analyzer.js'],
          });
          await new Promise(r => setTimeout(r, 300));
        }
      });

      const [snapResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try {
            return window.SmartMacroAnalyzer ? window.SmartMacroAnalyzer.snapshotPage() : null;
          } catch (e) { return { error: e.message }; }
        },
      });

      const snapshot = snapResult?.result;
      if (!snapshot || snapshot.error) {
        if (scanResults) {
          scanResults.classList.remove('hidden');
          scanResults.innerHTML = `<span style="color:#e74c3c">Scan failed: ${escHtml(snapshot?.error || 'Unknown error')}</span>`;
        }
        return;
      }

      // Display results
      if (scanResults) {
        scanResults.classList.remove('hidden');
        const rows = snapshot.fields
          .filter(f => f.isVisible)
          .map(f => {
            const section = f.sectionLabel ? `<span style="opacity:0.5"> [${escHtml(f.sectionLabel)}]</span>` : '';
            const tab_ = f.tabLabel ? `<span style="opacity:0.4"> ⊞${escHtml(f.tabLabel)}</span>` : '';
            const type = `<span style="opacity:0.4;font-size:10px">${escHtml(f.tagName)}${f.inputType ? ':' + escHtml(f.inputType) : ''}</span>`;
            const opts = f.options?.length ? `<span style="opacity:0.35"> (${f.options.length} opts)</span>` : '';
            return `<div class="scan-row">${type} <b>${escHtml(f.primaryLabel)}</b>${section}${tab_}${opts}</div>`;
          }).join('');
        const visCount = snapshot.fields.filter(f => f.isVisible).length;
        scanResults.innerHTML = `
          <div style="font-size:11px;opacity:0.7;margin-bottom:4px">
            ${visCount} visible fields on <em>${escHtml(snapshot.title || snapshot.url)}</em>
          </div>
          <div class="scan-rows" style="max-height:200px;overflow-y:auto;font-size:11px;line-height:1.7">${rows}</div>`;
      }
    } catch (err) {
      console.error('[SmartBot] Scan failed:', err);
    } finally {
      btnScanPage.disabled = false;
      btnScanPage.querySelector('span:last-child').textContent = 'Scan Page Fields (v9)';
    }
  });
}

// ── Debug mode toggle ─────────────────────────────────────
if (chkDebugMode) {
  chkDebugMode.addEventListener('change', async () => {
    const enabled = chkDebugMode.checked;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (flag) => { window.__smartbotDebug = flag; },
      args: [enabled],
    }).catch(() => {});
  });
}
