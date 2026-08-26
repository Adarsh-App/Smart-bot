// ============================================================
// SmartBot Background Service Worker — v9.0
// NEW: PAGE_SNAPSHOT storage, MacroAnalyzer integration, multi-tab deep fingerprint
// ============================================================

const State = {
  recording:         false,
  playing:           false,
  multiTab:          false,
  recordedSteps:     [],
  activeTabId:       null,
  playbackSpeed:     600,
  closeTabAfterDone: false,
  stopRequested:     false,
  pageSnapshots:     {},      // v9: tabId → full-page field map snapshot
};

// ── Persist / load ─────────────────────────────────────────
function saveState() {
  const { recording, playing, multiTab, recordedSteps, playbackSpeed, closeTabAfterDone } = State;
  chrome.storage.local.set({ smartbot_state: { recording, playing, multiTab, recordedSteps, playbackSpeed, closeTabAfterDone } });
}

async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get('smartbot_state', (data) => {
      if (data.smartbot_state) Object.assign(State, data.smartbot_state);
      // Never restore stopRequested as true
      State.stopRequested = false;
      resolve(State);
    });
  });
}

// ── Safe tab messaging (with retry) ────────────────────────
async function sendToTab(tabId, msg, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, msg, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });
      return response;
    } catch (err) {
      if (i === retries) throw err;
      await sleep(300);
    }
  }
}

// ── Execute steps on tab (with injection fallback) ──────────
async function executeOnTab(tabId, steps, speed) {
  try {
    return await sendToTab(tabId, { type: 'EXECUTE_STEPS', steps, speed });
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/analyzer.js', 'content/recorder.js', 'content/executor.js', 'content/overlay.js']
      });
      await sleep(400);
      return await sendToTab(tabId, { type: 'EXECUTE_STEPS', steps, speed });
    } catch (e) {
      throw new Error(`Tab ${tabId}: ${e.message}`);
    }
  }
}

// ── Broadcast to popup ──────────────────────────────────────
function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Message handler ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {

        case 'GET_STATE':
          await loadState();
          sendResponse({ success: true, state: State });
          break;

        case 'START_RECORDING': {
          State.recording = true;
          State.playing = false;
          State.recordedSteps = [];
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          State.activeTabId = tab.id;
          saveState();
          await sendToTab(tab.id, { type: 'START_RECORDING' }).catch(() => {});
          sendResponse({ success: true });
          break;
        }

        case 'STOP_RECORDING': {
          State.recording = false;
          saveState();
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await sendToTab(tab.id, { type: 'STOP_RECORDING' }).catch(() => {});
          sendResponse({ success: true, steps: State.recordedSteps });
          break;
        }

        case 'RECORD_STEP': {
          if (State.recording) {
            State.recordedSteps.push(msg.step);
            saveState();
            broadcast({ type: 'STEP_ADDED', step: msg.step, total: State.recordedSteps.length });
          }
          sendResponse({ success: true });
          break;
        }

        // v9: Store full-page field snapshot from MacroAnalyzer
        case 'PAGE_SNAPSHOT': {
          if (sender?.tab?.id) {
            State.pageSnapshots[sender.tab.id] = {
              snapshot: msg.snapshot,
              capturedAt: Date.now(),
            };
          }
          sendResponse({ success: true });
          break;
        }

        case 'UPDATE_STEPS': {
          State.recordedSteps = msg.steps;
          saveState();
          sendResponse({ success: true });
          break;
        }

        // ── NEW: Stop any running playback ──────────────────
        case 'STOP_PLAYBACK': {
          State.stopRequested = true;
          // Signal all tabs' content scripts to abort
          const allTabs = await chrome.tabs.query({ currentWindow: true });
          for (const t of allTabs) {
            sendToTab(t.id, { type: 'STOP_EXECUTION' }).catch(() => {});
          }
          sendResponse({ success: true });
          break;
        }

        // ── NEW: Toggle close-tab-after-done ───────────────
        case 'SET_CLOSE_TAB': {
          State.closeTabAfterDone = !!msg.enabled;
          saveState();
          sendResponse({ success: true });
          break;
        }

        case 'PLAY_CURRENT_TAB': {
          if (!State.recordedSteps.length) {
            sendResponse({ success: false, error: 'No steps recorded' });
            break;
          }
          State.playing = true;
          State.stopRequested = false;
          saveState();
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          broadcast({ type: 'PLAYBACK_TAB_START', tabId: tab.id, title: tab.title, index: 0, total: 1 });
          const result = await executeOnTab(tab.id, State.recordedSteps, State.playbackSpeed);
          const stopped = result?.stopped || State.stopRequested;

          // Close tab if setting enabled and not stopped
          if (!stopped && State.closeTabAfterDone) {
            await sleep(300);
            await chrome.tabs.remove(tab.id).catch(() => {});
            broadcast({ type: 'TAB_CLOSED', tabId: tab.id, title: tab.title });
          }

          State.playing = false;
          State.stopRequested = false;
          saveState();
          sendResponse({ success: !stopped, result });
          break;
        }

        case 'PLAY_ALL_TABS': {
          if (!State.recordedSteps.length) {
            sendResponse({ success: false, error: 'No steps recorded' });
            break;
          }
          State.playing = true;
          State.stopRequested = false;
          saveState();

          const allTabs = await chrome.tabs.query({ currentWindow: true });
          const eligible = allTabs.filter(t =>
            t.url &&
            !t.url.startsWith('chrome://') &&
            !t.url.startsWith('chrome-extension://')
          ).reverse(); // Play tabs from right to left

          const results = [];

          for (let idx = 0; idx < eligible.length; idx++) {
            const tab = eligible[idx];

            // Check stop signal before starting each tab
            if (State.stopRequested) {
              results.push({ tabId: tab.id, title: tab.title, success: false, error: 'Stopped by user' });
              continue;
            }

            try {
              await chrome.tabs.update(tab.id, { active: true });
              await sleep(300);

              broadcast({
                type: 'PLAYBACK_TAB_START',
                tabId: tab.id,
                title: tab.title,
                index: idx,
                total: eligible.length
              });

              const res = await executeOnTab(tab.id, State.recordedSteps, State.playbackSpeed);
              const stopped = res?.stopped || State.stopRequested;

              results.push({ tabId: tab.id, title: tab.title, success: !stopped && (res?.success !== false) });

              // NEW: Close tab after done if enabled (and not stopped)
              if (!stopped && State.closeTabAfterDone) {
                await sleep(300);
                await chrome.tabs.remove(tab.id).catch(() => {});
                broadcast({ type: 'TAB_CLOSED', tabId: tab.id, title: tab.title });
              } else {
                broadcast({ type: 'PLAYBACK_TAB_DONE', tabId: tab.id, title: tab.title });
              }

              if (stopped) {
                broadcast({ type: 'PLAYBACK_STOPPED', results });
                break;
              }

            } catch (e) {
              results.push({ tabId: tab.id, title: tab.title, success: false, error: e.message });
              broadcast({ type: 'PLAYBACK_TAB_DONE', tabId: tab.id, title: tab.title, error: e.message });
            }
          }

          State.playing = false;
          State.stopRequested = false;
          saveState();
          broadcast({ type: 'PLAYBACK_ALL_DONE', results });
          sendResponse({ success: true, results });
          break;
        }

        case 'SET_SPEED': {
          State.playbackSpeed = msg.speed;
          saveState();
          sendResponse({ success: true });
          break;
        }

        case 'CLEAR_STEPS': {
          State.recordedSteps = [];
          saveState();
          sendResponse({ success: true });
          break;
        }

        case 'GET_TABS': {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const filtered = tabs.filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
          sendResponse({ success: true, tabs: filtered.map(t => ({ id: t.id, title: t.title, url: t.url })) });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[SmartBot BG] Error handling', msg.type, err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true;
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
