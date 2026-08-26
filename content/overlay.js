// ============================================================
// SmartBot Page Overlay
// Floating mini-panel shown on the page during record/play
// ============================================================

(function () {
  if (document.getElementById('smartbot-overlay')) return;

  let overlayEl = null;

  function createOverlay() {
    const div = document.createElement('div');
    div.id = 'smartbot-overlay';
    div.innerHTML = `
      <div id="sbot-header">
        <span id="sbot-icon">⚡</span>
        <span id="sbot-title">SmartBot</span>
        <span id="sbot-status" class="sbot-idle">Idle</span>
      </div>
      <div id="sbot-progress">
        <div id="sbot-progress-bar"><div id="sbot-progress-fill"></div></div>
        <span id="sbot-progress-text"></span>
      </div>
      <div id="sbot-last-action"></div>
    `;
    document.body.appendChild(div);
    overlayEl = div;
  }

  function setStatus(text, cls) {
    const s = document.getElementById('sbot-status');
    if (s) {
      s.textContent = text;
      s.className = cls || 'sbot-idle';
    }
  }

  function setLastAction(text) {
    const el = document.getElementById('sbot-last-action');
    if (el) el.textContent = text;
  }

  function setProgress(current, total) {
    const fill = document.getElementById('sbot-progress-fill');
    const txt = document.getElementById('sbot-progress-text');
    if (fill) fill.style.width = total ? `${(current / total) * 100}%` : '0%';
    if (txt) txt.textContent = total ? `${current} / ${total}` : '';
  }

  // ── Event listeners ───────────────────────────────────────
  window.addEventListener('smartbot:step_recorded', (e) => {
    const step = e.detail;
    setStatus('● REC', 'sbot-recording');
    setLastAction(`✎ ${step.label || step.action}`);
  });

  window.addEventListener('smartbot:progress', (e) => {
    const { current, total, step } = e.detail;
    setStatus('▶ Playing', 'sbot-playing');
    setProgress(current, total);
    setLastAction(`▶ ${step.label || step.action}`);
  });

  window.addEventListener('smartbot:step_progress', (e) => {
    const { label, status } = e.detail;
    const icons = { running: '⟳', done: '✓', skipped: '⚠', error: '✗' };
    setLastAction(`${icons[status] || ''} ${label || ''}`);
  });

  window.addEventListener('smartbot:execution_complete', () => {
    setStatus('Done ✓', 'sbot-done');
    setProgress(0, 0);
    setTimeout(() => {
      setStatus('Idle', 'sbot-idle');
      setLastAction('');
    }, 3000);
  });

  // ── Init on load ──────────────────────────────────────────
  if (document.body) {
    createOverlay();
  } else {
    document.addEventListener('DOMContentLoaded', createOverlay);
  }

  // ── Message from background to show recording state ───────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_RECORDING') {
      setStatus('● REC', 'sbot-recording');
    } else if (msg.type === 'STOP_RECORDING') {
      setStatus('Stopped', 'sbot-idle');
    }
  });
})();
