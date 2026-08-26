// ============================================================
// SmartBot Recorder — v9.0
// ✦ Deep fingerprint (15 signals) stored in every step
// ✦ Full-page snapshot taken at recording start
// ✦ Macro-analyzer integration for human-precision labels
// ✦ All v8 fixes preserved
// ============================================================

window.SmartRecorder = (function () {

  let isRecording = false;
  let lastScrollY = 0;
  let scrollTimer = null;
  let inputTimer = null;
  let pendingInputEl = null;
  let pendingInputValue = null;
  let lastStepSignature = null;
  let lastStepTime = 0;

  // ── Step builder ─────────────────────────────────────────
  function buildStep(el, actionType, extraData = {}) {
    const context = window.SmartAnalyzer.analyzeElement(el);

    // ── v9: DEEP fingerprint — 15-signal label map via MacroAnalyzer ──
    let deepFingerprint = null;
    let labelFingerprint = null;
    try {
      if (window.SmartMacroAnalyzer) {
        deepFingerprint  = window.SmartMacroAnalyzer.buildDeepFingerprint(el);
        labelFingerprint = deepFingerprint;
      } else if (window.SmartLabelScanner) {
        labelFingerprint = window.SmartLabelScanner.buildFieldFingerprint(el);
      }
    } catch (_) {}

    return {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      action: actionType,
      ...context,
      deepFingerprint,
      labelFingerprint,
      ...extraData,
      url: location.href,
      pageTitle: document.title,
    };
  }

  // ── Dedup guard ───────────────────────────────────────────
  function isDuplicate(step) {
    const sig = `${step.action}|${step.selector?.selector}|${step.value ?? step.buttonText ?? ''}`;
    const now = Date.now();
    if (sig === lastStepSignature && (now - lastStepTime) < 400) return true;
    lastStepSignature = sig;
    lastStepTime = now;
    return false;
  }

  // ── FIX: Guard — skip steps for elements that are currently hidden ──
  // This prevents recording steps that target conditional fields
  // which may be invisible depending on another field's value (e.g.
  // "Consumer App QR" hidden when "Is Consumer App Downloaded?" = No).
  function isElementCurrentlyHidden(el) {
    if (!el) return true;
    // Walk up to detect display:none / visibility:hidden / aria-hidden
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (node.getAttribute('aria-hidden') === 'true') return true;
      // Common framework hidden patterns (ng-hide, v-show, React conditional)
      if (node.hidden) return true;
      node = node.parentElement;
    }
    // Zero-size elements are effectively invisible
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return false;
  }

  function sendStep(step) {
    if (isDuplicate(step)) return;
    chrome.runtime.sendMessage({ type: 'RECORD_STEP', step });
    window.dispatchEvent(new CustomEvent('smartbot:step_recorded', { detail: step }));
  }

  // ── Event Handlers ─────────────────────────────────────
  function onMouseDown(e) {
    if (!isRecording) return;
    const el = e.target;
    if (isExcluded(el)) return;
    // FIX: skip hidden elements
    if (isElementCurrentlyHidden(el)) return;
    const elType = window.SmartAnalyzer.classifyElement(el);

    if (['input', 'textarea', 'contenteditable', 'select'].includes(elType)) return;
    if (elType === 'custom-select' || window.SmartAnalyzer.isCustomDropdown(el)) return;

    const step = buildStep(el, elType === 'button' ? 'click_button' : 'click', {
      buttonText: el.innerText?.trim() || el.value || '',
      isSubmit: window.SmartAnalyzer.isSubmitButton(el),
    });
    sendStep(step);
  }

  function onCustomDropdownOptionClick(e) {
    if (!isRecording) return;
    const option = e.target.closest(
      '[role="option"], [role="menuitem"], [role="menuitemradio"], .dropdown-item, .select-option, .option-item, .ant-select-item-option, .ant-select-item, .MuiMenuItem-root, li[data-value], [data-radix-collection-item], [cmdk-item]'
    );
    if (!option || isExcluded(option)) return;

    const trigger =
      document.querySelector('[aria-expanded="true"]') ||
      document.querySelector('[aria-haspopup="listbox"]') ||
      document.querySelector('[aria-haspopup="true"]');

    const triggerHidden = trigger ? isElementCurrentlyHidden(trigger) : false;

    const selectedText  = option.innerText?.trim() || option.textContent?.trim() || '';
    // Prefer data-value / value attr, fall back to visible text
    const selectedValue = option.dataset.value
      || option.getAttribute('value')
      || option.getAttribute('data-key')
      || selectedText;

    // Capture ALL sibling options for cross-validation during playback
    const OPTION_QUERY = [
      '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]',
      '.dropdown-item', '.select-option', '.option-item',
      '.ant-select-item-option', '.ant-select-item',
      '.MuiMenuItem-root', 'li[data-value]',
      '[data-radix-collection-item]', '[cmdk-item]',
    ].join(', ');
    const allOptionsEls = Array.from(document.querySelectorAll(OPTION_QUERY))
      .filter(el => el.offsetParent !== null || el.getBoundingClientRect().height > 0);
    const allOptions    = allOptionsEls.map(o => ({
      text:  o.innerText?.trim() || o.textContent?.trim() || '',
      value: o.dataset.value || o.getAttribute('value') || '',
    }));
    const selectedIndex = allOptionsEls.indexOf(option); // positional fallback

    const base = trigger
      ? window.SmartAnalyzer.analyzeElement(trigger)
      : { label: 'Custom Dropdown', selector: {}, allSelectors: [], id: null, name: null };

    // v9: deep fingerprint for custom dropdown trigger
    let deepFingerprint = null;
    let labelFingerprint = null;
    try {
      if (trigger && window.SmartMacroAnalyzer) {
        deepFingerprint  = window.SmartMacroAnalyzer.buildDeepFingerprint(trigger);
        labelFingerprint = deepFingerprint;
      } else if (trigger && window.SmartLabelScanner) {
        labelFingerprint = window.SmartLabelScanner.buildFieldFingerprint(trigger);
      }
    } catch (_) {}

    sendStep({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      action: 'custom-select',
      ...base,
      deepFingerprint,
      labelFingerprint,
      selectedText,
      value: selectedValue,
      selectedIndex,
      allOptions,
      recordedVisible: !triggerHidden,
      url: location.href,
      pageTitle: document.title,
    });
  }

  function onFocus(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!isInputLike(el) || isExcluded(el)) return;
    // FIX: skip focus on hidden fields (e.g. Consumer App QR when hidden)
    if (isElementCurrentlyHidden(el)) return;
    pendingInputEl = el;
    pendingInputValue = el.value || el.innerText || '';
  }

  function onInput(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!isInputLike(el) || isExcluded(el)) return;
    // FIX: skip input events on hidden fields
    if (isElementCurrentlyHidden(el)) return;
    pendingInputEl = el;
    pendingInputValue = el.value || el.innerText || '';

    const delay = pendingInputValue.length > 20 ? 800 : 600;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(flushPendingInput, delay);
  }

  function flushPendingInput() {
    if (!pendingInputEl || !isRecording) return;
    // FIX: don't flush if the field has since become hidden
    if (isElementCurrentlyHidden(pendingInputEl)) {
      pendingInputEl = null;
      pendingInputValue = null;
      return;
    }
    const el = pendingInputEl;
    const value = el.value || el.innerText || pendingInputValue || '';
    if (!value.trim() && el.type !== 'search') {
      pendingInputEl = null;
      pendingInputValue = null;
      return;
    }
    const step = buildStep(el, 'type', {
      value,
      isSensitive: el.type === 'password',
      recordedVisible: true,
    });
    sendStep(step);
    pendingInputEl = null;
    pendingInputValue = null;
  }

  function onBlur(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!isInputLike(el) || isExcluded(el)) return;
    clearTimeout(inputTimer);
    if (pendingInputEl === el) flushPendingInput();
  }

  function onChange(e) {
    if (!isRecording) return;
    const el = e.target;
    if (isExcluded(el)) return;
    // FIX: skip changes on hidden elements
    if (isElementCurrentlyHidden(el)) return;
    const elType = window.SmartAnalyzer.classifyElement(el);

    if (elType === 'select') {
      const selectedOption = el.options[el.selectedIndex];
      sendStep(buildStep(el, 'select', {
        value: el.value,
        selectedText: selectedOption?.text || el.value,
        allOptions: Array.from(el.options).map(o => ({ value: o.value, text: o.text })),
        recordedVisible: true,
      }));
    } else if (elType === 'checkbox') {
      sendStep(buildStep(el, 'checkbox', { checked: el.checked, recordedVisible: true }));
    } else if (elType === 'radio') {
      sendStep(buildStep(el, 'radio', { value: el.value, checked: el.checked, recordedVisible: true }));
    }
  }

  function onScroll() {
    if (!isRecording) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const currentY = window.scrollY;
      const delta = currentY - lastScrollY;
      if (Math.abs(delta) > 80) {
        sendStep({
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          action: 'scroll',
          scrollY: currentY,
          scrollDelta: delta,
          direction: delta > 0 ? 'down' : 'up',
          url: location.href,
          label: `Scroll ${delta > 0 ? 'down' : 'up'} to ${Math.round(currentY)}px`,
        });
        lastScrollY = currentY;
      }
    }, 400);
  }

  // ── Helpers ───────────────────────────────────────────────
  function isInputLike(el) {
    const tag = el.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
  }

  function isExcluded(el) {
    return el.closest('#smartbot-overlay') !== null;
  }

  // ── Public API ────────────────────────────────────────────
  function start() {
    if (isRecording) return;
    isRecording = true;
    lastScrollY = window.scrollY;
    lastStepSignature = null;

    // v9: Take full-page snapshot at recording start
    // This seeds the MacroAnalyzer pageMap with all current fields
    // so every subsequent step gets rich context labels
    try {
      if (window.SmartMacroAnalyzer) {
        const snapshot = window.SmartMacroAnalyzer.snapshotPage();
        chrome.runtime.sendMessage({ type: 'PAGE_SNAPSHOT', snapshot }).catch(() => {});
        console.log('[SmartBot] v9 Page snapshot taken —', snapshot.fieldCount, 'fields mapped');
      }
    } catch (_) {}

    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('click', onCustomDropdownOptionClick, true);
    document.addEventListener('focus', onFocus, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('blur', onBlur, true);
    document.addEventListener('change', onChange, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });

    console.log('[SmartBot] ● Recording started');
  }

  function stop() {
    if (!isRecording) return;
    isRecording = false;
    clearTimeout(inputTimer);
    clearTimeout(scrollTimer);
    if (pendingInputEl) flushPendingInput();

    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('click', onCustomDropdownOptionClick, true);
    document.removeEventListener('focus', onFocus, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('blur', onBlur, true);
    document.removeEventListener('change', onChange, true);
    window.removeEventListener('scroll', onScroll, true);

    console.log('[SmartBot] ■ Recording stopped');
  }

  return { start, stop, isRecording: () => isRecording };
})();
