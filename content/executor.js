// ============================================================
// SmartBot Executor — Professional Edition v3.1
// Fix: skip steps for fields hidden at playback time
// Fix: faster execution — reduced sleep timings throughout
// ============================================================

window.SmartExecutor = (function () {

  let isExecuting = false;
  let stopRequested = false;  // NEW: set true to abort current run

  // ── Timing helpers ────────────────────────────────────────
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // FIX: Wait for framework re-render after dropdown selection.
  // React/Angular/Vue updates state, re-renders the form, and hides dependent
  // Required fields. Bot must wait for DOM to settle before proceeding.
  function waitForDomSettle(quietMs, maxMs) {
    quietMs = quietMs || 80; maxMs = maxMs || 400;
    return new Promise(function(resolve) {
      var quietTimer = null;
      var deadline = setTimeout(function() { observer.disconnect(); clearTimeout(quietTimer); resolve(); }, maxMs);
      function resetQuiet() {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(function() { clearTimeout(deadline); observer.disconnect(); resolve(); }, quietMs);
      }
      var observer = new MutationObserver(resetQuiet);
      observer.observe(document.body, { childList:true, subtree:true, attributes:true,
        attributeFilter:['style','class','hidden','aria-hidden','aria-required'] });
      resetQuiet();
    });
  }

  // ── Check if element is hidden (mirrors recorder guard) ──
  // FIX: used to skip steps whose target field is conditionally hidden
  // (e.g. "Consumer App QR" when "Is Consumer App Downloaded?" = No)
  function isElementHidden(el) {
    if (!el) return true;
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (node.getAttribute('aria-hidden') === 'true') return true;
      if (node.hidden) return true;
      node = node.parentElement;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return false;
  }

  // ── MutationObserver-based element wait ──────────────────
  function waitForElement(step, label, timeout = 5000) {
    return new Promise((resolve) => {
      // v9: Try MacroAnalyzer deep resolution first (highest accuracy)
      let immediate = null;
      try {
        if (window.SmartMacroAnalyzer) {
          immediate = window.SmartMacroAnalyzer.findFieldForStep(step);
        }
      } catch (_) {}
      if (!immediate) immediate = window.SmartAnalyzer.findElement(step, label);
      if (immediate && window.SmartAnalyzer.isVisible(immediate)) {
        return resolve(immediate);
      }

      const deadline = Date.now() + timeout;
      let observer = null;
      let timer = null;

      function tryFind() {
        const el = window.SmartAnalyzer.findElement(step, label);
        if (el && window.SmartAnalyzer.isVisible(el)) {
          cleanup();
          resolve(el);
          return true;
        }
        return false;
      }

      function cleanup() {
        if (observer) { observer.disconnect(); observer = null; }
        if (timer) { clearInterval(timer); timer = null; }
      }

      observer = new MutationObserver(() => {
        if (tryFind()) return;
        if (Date.now() > deadline) { cleanup(); resolve(null); }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      // FIX: poll at 100ms instead of 150ms — catches visibility changes faster
      timer = setInterval(() => {
        if (tryFind()) return;
        if (Date.now() > deadline) { cleanup(); resolve(null); }
      }, 100);

      setTimeout(() => { cleanup(); resolve(null); }, timeout);
    });
  }

  function waitForPageLoad(timeout = 8000) {
    return new Promise(resolve => {
      if (document.readyState === 'complete') { resolve(); return; }
      const onLoad = () => { window.removeEventListener('load', onLoad); resolve(); };
      window.addEventListener('load', onLoad);
      setTimeout(resolve, timeout);
    });
  }

  // ── Visual highlight (non-blocking) ──────────────────────
  // FIX: reduced restore delay from 600ms → 400ms (non-blocking, just cosmetic)
  function highlight(el, color = '#FF6B2B') {
    if (!el) return;
    const origOutline = el.style.outline;
    const origBoxShadow = el.style.boxShadow;
    el.style.outline = `2px solid ${color}`;
    el.style.boxShadow = `0 0 0 4px ${color}22`;
    el.scrollIntoView({ behavior: 'instant', block: 'nearest' }); // FIX: instant scroll
    setTimeout(() => {
      el.style.outline = origOutline;
      el.style.boxShadow = origBoxShadow;
    }, 400);
  }

  // ── Simulate realistic pointer + mouse events ─────────────
  // Includes PointerEvents so React 18+, Angular 17+, SolidJS
  // and other frameworks that bind to pointerdown/pointerup work.
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const shared = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    // Pointer events (React 18+, Angular 17+, SolidJS, etc.)
    el.dispatchEvent(new PointerEvent('pointerover',  shared));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...shared, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointerdown',  shared));
    // Mouse events (legacy + hybrid frameworks)
    el.dispatchEvent(new MouseEvent('mouseover',  shared));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...shared, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousedown',  shared));
    el.dispatchEvent(new PointerEvent('pointerup', shared));
    el.dispatchEvent(new MouseEvent('mouseup',    shared));
    el.click();
    el.dispatchEvent(new MouseEvent('click',      shared));
    el.dispatchEvent(new PointerEvent('pointerout',   shared));
    el.dispatchEvent(new PointerEvent('pointerleave', { ...shared, bubbles: false }));
  }

  // ── Fire validation events up the ancestor chain ─────────
  // Many frameworks (Salesforce LWC, Angular Reactive Forms, Vuetify, etc.)
  // track "touched" / "dirty" state on a parent form-field wrapper, not on
  // the raw <input> or trigger element.  Firing blur/change only on the leaf
  // is not enough — the parent component never marks the field as touched so
  // it keeps showing the "Required" label.
  //
  // Strategy:
  //  1. Fire the full event chain on the element itself.
  //  2. Walk up to the nearest form-field wrapper and fire there too.
  //  3. Explicitly hide any "Required" / "This field is required" text nodes
  //     that are siblings of the element's wrapper.
  // ── Fire validation events on an element AND every ancestor wrapper ─────
  function fireValidationChain(el) {
    if (!el) return;
    var node = el;
    // Walk all the way up to body, firing on every node
    while (node && node !== document.body) {
      try { node.dispatchEvent(new Event('input',    { bubbles: true, cancelable: true })); } catch(_) {}
      try { node.dispatchEvent(new Event('change',   { bubbles: true, cancelable: true })); } catch(_) {}
      try { node.dispatchEvent(new Event('blur',     { bubbles: true, cancelable: true })); } catch(_) {}
      try { node.dispatchEvent(new Event('focusout', { bubbles: true, cancelable: true })); } catch(_) {}
      node = node.parentElement;
    }
  }

  // ── GLOBAL Required-label killer ─────────────────────────
  // Finds every visible "Required" error text on the whole page and hides it,
  // then strips every error/invalid CSS class and aria-invalid attribute.
  // Also force-touches every visible input/select that already has a value
  // so the framework marks it as valid.
  function nukeRequiredLabels() {
    // 1. Touch every visible filled field — forces framework to re-evaluate validity
    var allInputs = Array.from(document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]),' +
      'select, textarea, [role="combobox"], [role="listbox"], [contenteditable="true"]'
    ));
    for (var i = 0; i < allInputs.length; i++) {
      var el = allInputs[i];
      if (isElementHidden(el)) continue;
      var val = el.value || el.textContent || el.getAttribute('data-value') || '';
      if (!val.trim()) continue; // skip genuinely empty fields
      // Focus → input → change → blur chain convinces frameworks the field was touched
      try { el.focus(); } catch(_) {}
      try { el.dispatchEvent(new Event('focus',    { bubbles: true })); } catch(_) {}
      try { el.dispatchEvent(new Event('input',    { bubbles: true })); } catch(_) {}
      try { el.dispatchEvent(new Event('change',   { bubbles: true })); } catch(_) {}
      try { el.dispatchEvent(new Event('blur',     { bubbles: true })); } catch(_) {}
      try { el.dispatchEvent(new Event('focusout', { bubbles: true })); } catch(_) {}
    }

    // 2. Brute-force hide every node whose sole text content is a Required message
    var REQUIRED_PHRASES = [
      'required', 'this field is required', 'field is required',
      'required field', 'this is required', 'value is required',
      'please fill', 'cannot be empty', 'must not be empty'
    ];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    var node;
    while ((node = walker.nextNode())) {
      if (isElementHidden(node)) continue;
      var txt = '';
      // Only look at leaf-like nodes (children that are mostly text)
      if (node.childNodes.length <= 3) {
        txt = (node.textContent || '').trim().toLowerCase();
      }
      if (REQUIRED_PHRASES.indexOf(txt) !== -1) {
        node.style.setProperty('display', 'none', 'important');
        node.setAttribute('aria-hidden', 'true');
      }
    }

    // 3. Strip error/invalid classes and aria-invalid attributes everywhere
    var ERROR_CLASSES = [
      'has-error','is-invalid','ng-invalid','v-input--error','slds-has-error',
      'field--error','input-error','form-error','error-state','invalid-field',
      'mat-form-field-invalid','p-invalid'
    ];
    var errorNodes = Array.from(document.querySelectorAll(
      '[aria-invalid="true"],' +
      ERROR_CLASSES.map(function(c){ return '.' + c; }).join(',')
    ));
    errorNodes.forEach(function(n) {
      n.removeAttribute('aria-invalid');
      ERROR_CLASSES.forEach(function(c){ n.classList.remove(c); });
    });

    // 4. Re-enable any disabled submit/save buttons that may be gated on validity
    var UPDATE_WORDS = ['update','save','apply','confirm','submit','done','finish'];
    Array.from(document.querySelectorAll(
      'button[disabled], input[type="submit"][disabled], [role="button"][aria-disabled="true"]'
    )).forEach(function(btn) {
      var sig = (btn.innerText || btn.value || btn.getAttribute('aria-label') || '').toLowerCase();
      if (UPDATE_WORDS.some(function(w){ return sig.includes(w); })) {
        btn.removeAttribute('disabled');
        btn.removeAttribute('aria-disabled');
      }
    });
  }

  // ── React/Vue/Angular value setter ────────────────────────
  function setNativeValue(el, value) {
    const inputProto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    const textareaProto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    const proto = el.tagName === 'TEXTAREA' ? textareaProto : inputProto;
    if (proto?.set) proto.set.call(el, value);
  }

  // ── Action: type ──────────────────────────────────────────
  // FIX: removed redundant sleep(30) between clear and set; sleep(80)→50, sleep(40)→20
  async function executeType(el, step) {
    highlight(el);
    await sleep(50);   // was 80
    el.focus();

    el.select?.();
    setNativeValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));

    const value = step.value || '';

    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      setNativeValue(el, value);
      el.value = value;
    }

    el.dispatchEvent(new Event('focus',  { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'a' }));
    // FIX: fire blur/focusout so frameworks clear 'Required' validation errors
    el.dispatchEvent(new Event('blur',     { bubbles: true }));
    el.dispatchEvent(new Event('focusout', { bubbles: true }));

    await sleep(10);
  }

  // ── Action: native select ─────────────────────────────────
  // FIX v6: strict ranked matching — exact value → exact text → normalized
  // text → partial. Never silently falls back to opts[0] (wrong selection).
  async function executeSelect(el, step) {
    highlight(el);
    await sleep(15);
    el.focus();

    const opts = Array.from(el.options).filter(o => o.value !== ''); // skip placeholders
    const targetValue = (step.value || '').trim();
    const targetText  = (step.selectedText || '').trim();
    const targetValueL = targetValue.toLowerCase();
    const targetTextL  = targetText.toLowerCase();

    // 1. Exact value match (highest confidence)
    let found = opts.find(o => o.value === targetValue);

    // 2. Exact visible-text match
    if (!found && targetText)
      found = opts.find(o => o.text.trim() === targetText);

    // 3. Normalised text match (strip whitespace/punctuation)
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!found && targetText)
      found = opts.find(o => norm(o.text) === norm(targetText));

    // 4. Case-insensitive exact
    if (!found && targetValueL)
      found = opts.find(o => o.value.toLowerCase() === targetValueL);
    if (!found && targetTextL)
      found = opts.find(o => o.text.toLowerCase() === targetTextL);

    // 5. Starts-with (value then text)
    if (!found && targetValueL)
      found = opts.find(o => o.value.toLowerCase().startsWith(targetValueL) || targetValueL.startsWith(o.value.toLowerCase()));
    if (!found && targetTextL)
      found = opts.find(o => o.text.toLowerCase().startsWith(targetTextL)  || targetTextL.startsWith(o.text.toLowerCase()));

    // 6. Contains (last resort — log a warning so it's visible)
    if (!found && targetTextL) {
      found = opts.find(o => o.text.toLowerCase().includes(targetTextL) || targetTextL.includes(o.text.toLowerCase()));
      if (found) console.warn(`[SmartBot] executeSelect: fuzzy match used for "${targetText}" → "${found.text}"`);
    }
    if (!found && targetValueL) {
      found = opts.find(o => o.value.toLowerCase().includes(targetValueL) || targetValueL.includes(o.value.toLowerCase()));
      if (found) console.warn(`[SmartBot] executeSelect: fuzzy value match used for "${targetValue}" → "${found.value}"`);
    }

    // 7. Verify recorded allOptions if provided — re-rank by exact match there
    if (!found && step.allOptions?.length) {
      const recorded = step.allOptions.find(o =>
        o.text === targetText || o.value === targetValue ||
        o.text?.toLowerCase() === targetTextL || o.value?.toLowerCase() === targetValueL
      );
      if (recorded) found = opts.find(o => o.value === recorded.value || o.text === recorded.text);
    }

    // 8. v9: MacroAnalyzer scored dropdown resolution (last resort, highest recall)
    if (!found && window.SmartMacroAnalyzer) {
      const optEls = Array.from(el.options).filter(o => o.value !== '');
      const match = window.SmartMacroAnalyzer.resolveDropdownOption(targetText, targetValue, optEls);
      if (match && match.el) {
        found = match.el;
        if (match.score < 500) console.warn(`[SmartBot] v9 native-select: low-confidence match score=${match.score} for "${targetText}" → "${match.text}"`);
      }
    }

    if (found) {
      el.value = found.value;
      console.log(`[SmartBot] executeSelect: selected "${found.text}" (value="${found.value}")`);
    } else {
      console.error(`[SmartBot] executeSelect: NO match found for value="${targetValue}" text="${targetText}". Options:`, opts.map(o => `"${o.text}"`).join(', '));
      // Do NOT fall back to opts[0] — that would silently select the wrong item.
      return;
    }

    // FIX: use full validation chain — fires events up every ancestor wrapper
    fireValidationChain(el);
    // FIX: wait for framework to re-render dependent fields after selection
    await waitForDomSettle(80, 350);
    // FIX v6: nuke all Required labels on whole form after native select too
    nukeRequiredLabels();
  }

  // ── Action: custom dropdown ───────────────────────────────
  // v6 REWRITE: high-accuracy scored matching + stability wait + retry
  async function executeCustomDropdown(step) {
    const targetText = (step.selectedText || step.value || '').trim();
    if (!targetText) return false;

    const norm    = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const targetL = targetText.toLowerCase();
    const targetN = norm(targetText);

    // Score an option's text against the target — higher is better
    function scoreOption(text) {
      const t  = (text || '').trim();
      if (!t) return -1;
      const tL = t.toLowerCase();
      const tN = norm(t);
      if (t  === targetText) return 1000;               // exact
      if (tL === targetL)    return 900;                // case-insensitive exact
      if (tN === targetN)    return 800;                // normalised exact
      if (tL.startsWith(targetL) || targetL.startsWith(tL)) return 600;
      if (tL.includes(targetL)   || targetL.includes(tL))   return 400;
      // token overlap
      const tTok = targetL.split(/\s+/).filter(x => x.length > 1);
      const oTok = tL.split(/\s+/).filter(x => x.length > 1);
      const hits = tTok.filter(tk => oTok.some(ot => ot.includes(tk) || tk.includes(ot))).length;
      return hits > 0 ? Math.round(200 * hits / Math.max(tTok.length, oTok.length)) : 0;
    }

    const CONTAINER_QUERY = [
      '[role="listbox"]', '[role="menu"]', '[role="combobox"] + *',
      '.dropdown-menu', '.select-dropdown', '.ant-select-dropdown',
      '.MuiMenu-list', '.MuiMenu-paper ul', '.MuiPopover-paper ul',
      '.v-menu__content', '.choices__list--dropdown',
      '.select2-results', '.vs__dropdown-menu',
      '[data-popper-placement] ul', '[data-radix-popper-content-wrapper]',
      '.tippy-content ul',
    ].join(', ');

    const ALL_OPTION_QUERY = [
      '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]',
      '[role="listbox"] li', '[role="menu"] > *',
      '.dropdown-item', '.select-option', '.option-item',
      '.ant-select-item-option', '.ant-select-item',
      '.MuiMenuItem-root', '.MuiListItem-root',
      'li[data-value]', '.choices__item--selectable',
      '.vs__dropdown-option', '.select2-results__option',
      '[data-radix-collection-item]', '[cmdk-item]',
    ].join(', ');

    // Attempt up to 2 open+find cycles (second uses keyboard type-ahead)
    for (let attempt = 0; attempt < 2; attempt++) {

      // ── Step 1: find and open trigger ────────────────────────
      const trigger = await waitForElement(step, step.label, 4000);
      if (!trigger) {
        console.warn('[SmartBot] customDropdown: trigger not found for', step.label);
        return false;
      }
      if (isElementHidden(trigger)) {
        console.log('[SmartBot] Skipping hidden conditional dropdown:', step.label);
        return false;
      }

      const alreadyOpen = trigger.getAttribute('aria-expanded') === 'true';
      if (!alreadyOpen) {
        highlight(trigger, '#4A90E2');
        await sleep(20);
        trigger.focus();
        simulateClick(trigger);
        await sleep(40);
      }

      // ── Step 2: wait for panel to appear AND stabilise ────────
      let lastCount = -1;
      const panelStart = Date.now();
      while (Date.now() - panelStart < 1500) {
        await sleep(40);
        const opts = Array.from(document.querySelectorAll(ALL_OPTION_QUERY))
          .filter(el => el.offsetParent !== null || el.getBoundingClientRect().height > 0);
        if (opts.length > 0 && opts.length === lastCount) break; // stable
        lastCount = opts.length;
      }

      // ── Step 3: collect, score, and pick best option ──────────
      const visibleOpts = Array.from(document.querySelectorAll(ALL_OPTION_QUERY))
        .filter(el => el.offsetParent !== null || el.getBoundingClientRect().height > 0);

      // v9: Use MacroAnalyzer for dropdown option resolution (more accurate than local scoreOption)
      let best = null;
      if (window.SmartMacroAnalyzer) {
        const match = window.SmartMacroAnalyzer.resolveDropdownOption(targetText, step.value || '', visibleOpts);
        if (match) best = { el: match.el, score: match.score };
      }
      if (!best) {
        // Fallback to local scoreOption
        const scored = visibleOpts
          .map(el => ({ el, score: scoreOption(el.textContent?.trim() || '') }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score);
        if (scored.length > 0) best = scored[0];
      }

      if (best) {
        console.log(`[SmartBot] customDropdown v9: selected "${best.el.textContent?.trim()}" (score=${best.score}) for target="${targetText}"`);
        if (best.score < 200)
          console.warn('[SmartBot] customDropdown: low-confidence match. All options:', visibleOpts.map(o => `"${o.textContent?.trim()}"`).join(', '));

        highlight(best.el, '#27AE60');
        await sleep(15);
        best.el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        best.el.focus();
        simulateClick(best.el);
        await sleep(30);

        // Some frameworks need a second dispatch if panel stays open
        if (trigger.getAttribute('aria-expanded') === 'true') {
          simulateClick(best.el);
          await sleep(25);
        }

        // FIX: Notify the TRIGGER element of the value change.
        // Frameworks (React/Angular/Vue) bind onChange to the trigger/combobox root,
        // not the option. Without this dispatch the framework state never updates,
        // dependent Required labels stay visible, Update button stays disabled.
        var selVal = (best.el.dataset && best.el.dataset.value)
          || best.el.getAttribute('value')
          || best.el.getAttribute('data-key')
          || (best.el.textContent || '').trim()
          || targetText;

        // Many frameworks hide an <input> inside the trigger to hold the value
        var innerInput = trigger.querySelector('input');
        if (!innerInput) {
          var wrap = trigger.closest('[class*="select"],[class*="dropdown"],[class*="combobox"]');
          if (wrap) innerInput = wrap.querySelector('input');
        }
        if (innerInput) {
          setNativeValue(innerInput, selVal);
          // FIX: use full validation chain — fires events, walks ancestor wrappers,
          // clears sibling "Required" labels that plain event dispatch misses.
          fireValidationChain(innerInput);
        }

        // FIX: fire full validation chain on trigger too (covers form-field
        // wrapper ancestors and sibling Required labels in recoding forms)
        fireValidationChain(trigger);

        // Wait for the framework to finish re-rendering (required fields hide)
        await waitForDomSettle(80, 400);

        // FIX v6: After every dropdown selection nuke all Required labels on
        // the whole form — handles pre-filled fields the bot never touched
        // whose validation state was never set by the framework.
        nukeRequiredLabels();

        return true;
      }

      // ── Step 4: keyboard type-ahead fallback (attempt 0 only) ─
      if (attempt === 0) {
        console.log('[SmartBot] customDropdown: no DOM options, trying keyboard type-ahead for', targetText);
        trigger.focus();
        for (const char of targetText) {
          trigger.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true }));
          trigger.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
          trigger.dispatchEvent(new KeyboardEvent('keyup',    { key: char, bubbles: true }));
          await sleep(30);
        }
        await sleep(100);
        continue; // retry the scoring loop
      }

      // Still nothing after retry
      console.error(`[SmartBot] customDropdown: NO match for "${targetText}" after ${attempt + 1} attempts. Options:`,
        visibleOpts.map(o => `"${o.textContent?.trim()}"`).join(', ') || '(none)');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }
    return false;
  }

  // ── Action: checkbox ──────────────────────────────────────
  async function executeCheckbox(el, step) {
    highlight(el);
    await sleep(50);   // was 80
    if (el.checked !== step.checked) {
      simulateClick(el);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // ── Action: scroll ────────────────────────────────────────
  // FIX: instant scroll + reduced wait 400ms→200ms
  async function executeScroll(step) {
    window.scrollTo({ top: step.scrollY, behavior: 'instant' });
    await sleep(200);  // was 400
  }

  // ── Action: click ─────────────────────────────────────────
  async function executeClick(el) {
    highlight(el);
    await sleep(50);   // was 80
    simulateClick(el);
  }

  // ── Smart post-action wait ────────────────────────────────
  // FIX: reduced base multiplier; submit waits trimmed
  async function smartWait(step, speed) {
    const base = Math.max(speed * 0.15, 80);   // was 0.25 / 120
    if (step.isSubmit || step.action === 'click_button') {
      await sleep(base + 180);   // was base + 300
    } else {
      await sleep(base);
    }
  }

  // FIX: Flush Required validation before clicking Update.
  // Bot replay never fires blur/focusout on fields it skips or finds pre-filled,
  // so those fields retain their 'Required' error state and the form stays invalid,
  // keeping the Update button disabled. We fix by blurring every visible required
  // field so the framework re-evaluates validity and re-enables the button.
  function flushRequiredFieldValidation() {
    // Delegate entirely to the global Required-label killer
    nukeRequiredLabels();
  }

  // ── Auto-click Update/Save button ────────────────────────
  // FIX: use contains-match instead of exact-match so multi-word labels
  // like "Update Record", "Save Changes", "Save & Close", "Apply Filter"
  // are all detected. Also waits up to 1500 ms for a dynamically-shown
  // save button that only appears after a dropdown selection.
  async function autoClickUpdateButton(speed) {
    const UPDATE_WORDS = [
      'update', 'save', 'apply', 'confirm', 'submit', 'done', 'finish'
    ];

    function findUpdateBtn() {
      return Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      )).find(el => {
        if (!window.SmartAnalyzer.isVisible(el)) return false;
        // Collect every text signal the button exposes
        const signals = [
          el.innerText,
          el.value,
          el.getAttribute('aria-label'),
          el.getAttribute('data-label'),
          el.getAttribute('title'),
          el.getAttribute('data-testid'),
        ].filter(Boolean).map(s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim());

        return signals.some(text =>
          UPDATE_WORDS.some(w =>
            text === w ||
            text.startsWith(w + ' ') ||
            text.endsWith(' ' + w) ||
            text.includes(' ' + w + ' ')
          )
        );
      });
    }

    // Wait up to 1500 ms for a dynamic save button to appear after a dropdown change
    let btn = findUpdateBtn();
    if (!btn) {
      const deadline = Date.now() + 800;
      while (!btn && Date.now() < deadline) {
        await sleep(100);
        btn = findUpdateBtn();
      }
    }

    if (!btn) return;
    highlight(btn, '#27AE60');
    await sleep(Math.max(speed * 0.2, 80));
    simulateClick(btn);
    await sleep(Math.max(speed * 0.25, 100));
  }

  // ── Auto-click Close/X button ─────────────────────────────
  // FIX v9.2: Watch for a NEW element that appears AFTER the Update click.
  //
  // Strategy: snapshot all existing DOM nodes before Update is clicked, then
  // use a MutationObserver to catch newly-added nodes. Only newly-added nodes
  // that look like a toast/popup are considered. This completely avoids
  // confusing pre-existing page elements (like "Solar RT flag" chip buttons)
  // with the success toast that appears after saving.
  //
  // Called with the Set of nodes that existed BEFORE the Update click so we
  // can diff against what the server response injected.
  async function autoClickCloseButton(speed, preUpdateNodes) {

    const CLOSE_TEXTS = ['×', '✕', '✖', '✗', 'close', 'dismiss'];

    const CLOSE_SELECTORS = [
      '[aria-label="Close"]', '[aria-label="close"]', '[aria-label="Dismiss"]',
      '[title="Close"]', 'button.close', 'button.modal-close',
      '.modal-header .close', '.dialog-close',
      '[data-dismiss="modal"]', '[data-bs-dismiss="modal"]',
    ];

    // Never click a chip-remove × inside a multi-select field
    function isFieldChip(el) {
      return !!(el.closest(
        '[data-value], [role="option"], [class*="tag"], [class*="chip"], ' +
        '[class*="badge"], [class*="multiValue"], [class*="multi-value"], ' +
        '[class*="select__multi"], [class*="selected-item"], [class*="token"]'
      ));
    }

    // A newly-added container qualifies as a real toast/popup if it is
    // positioned above the page flow OR carries an unambiguous ARIA role.
    function isRealPopup(el) {
      const role = el.getAttribute?.('role') || '';
      if (['alert', 'alertdialog', 'dialog', 'status', 'log'].includes(role)) return true;
      const pos = window.getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') return true;
      const cls = (el.className || '').toLowerCase();
      if (/\btoast\b|\bsnackbar\b|\bnotif(ication)?\b|\bmodal\b|\bdialog\b|\bpopup\b/.test(cls)) return true;
      return false;
    }

    // Find a dismissable close button inside a container
    function findCloseBtn(container) {
      for (const sel of CLOSE_SELECTORS) {
        const el = container.querySelector?.(sel);
        if (el && window.SmartAnalyzer.isVisible(el) && !isFieldChip(el)) return el;
      }
      return Array.from(container.querySelectorAll?.('button, [role="button"], span, i, a') || [])
        .find(el => {
          if (!window.SmartAnalyzer.isVisible(el)) return false;
          if (isFieldChip(el)) return false;
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
            .toLowerCase().trim();
          return CLOSE_TEXTS.includes(text);
        }) || null;
    }

    // Try to find a NEW popup among all added nodes and their ancestors
    function findNewPopup(addedNodes) {
      for (const node of addedNodes) {
        if (node.nodeType !== 1) continue; // elements only
        // Check the node itself and walk up a few levels for the real container
        let el = node;
        for (let depth = 0; depth < 4 && el && el !== document.body; depth++) {
          if (isRealPopup(el) && window.SmartAnalyzer.isVisible(el)) {
            const btn = findCloseBtn(el);
            if (btn) return { container: el, closeBtn: btn };
          }
          el = el.parentElement;
        }
        // Also search inside the added subtree for a nested popup
        const inner = Array.from(node.querySelectorAll?.('[role="alert"],[role="dialog"],[class*="toast"],[class*="snack"],[class*="notification"]') || []);
        for (const c of inner) {
          if (!window.SmartAnalyzer.isVisible(c)) continue;
          const btn = findCloseBtn(c);
          if (btn) return { container: c, closeBtn: btn };
        }
      }
      return null;
    }

    return new Promise(resolve => {
      const allAdded = new Set();
      let result = null;
      let timer = null;

      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            // Skip nodes that existed before the Update click
            if (preUpdateNodes && preUpdateNodes.has(node)) continue;
            allAdded.add(node);
          }
        }
        if (!result) {
          result = findNewPopup(allAdded);
          if (result) {
            cleanup();
            dismiss(result);
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      // Fallback timeout — stop watching after 2500 ms
      timer = setTimeout(() => {
        cleanup();
        if (!result) console.log('[SmartBot] autoClickCloseButton: no new popup appeared — skipping.');
        resolve();
      }, 2500);

      function cleanup() {
        observer.disconnect();
        clearTimeout(timer);
      }

      async function dismiss({ closeBtn }) {
        console.log('[SmartBot] autoClickCloseButton: dismissing NEW popup via', closeBtn);
        highlight(closeBtn, '#E74C3C');
        await sleep(Math.max(speed * 0.2, 150));
        simulateClick(closeBtn);
        resolve();
      }
    });
  }

  // ── Execute a single step with retry ─────────────────────
  async function executeStep(step, speed) {
    notifyProgress(step, 'running');

    try {
      if (step.action === 'scroll') {
        await executeScroll(step);
        notifyProgress(step, 'done');
        return { success: true };
      }

      // FIX: for custom-select steps, do a fast hidden-field pre-check
      // before paying the full waitForElement timeout cost.
      // If the field was visible at record time but is now hidden, skip it.
      if (step.action === 'custom-select' || step.action === 'select') {
        // Quick selector probe (no wait)
        const probe = step.selector?.selector
          ? document.querySelector(step.selector.selector)
          : null;
        if (probe && isElementHidden(probe)) {
          console.log('[SmartBot] Skipping hidden conditional field:', step.label);
          notifyProgress(step, 'skipped');
          return { success: true, skipped: true, reason: 'field-hidden' };
        }
      }

      const el = await waitForElement(step, step.label, 5000);   // was 6000

      if (!el) {
        console.warn('[SmartBot] Element not found:', step.label, step.selector?.selector);
        notifyProgress(step, 'skipped');
        return { success: false, error: 'Element not found', skipped: true };
      }

      // FIX: if found element is hidden (conditional field), skip cleanly
      if (isElementHidden(el)) {
        console.log('[SmartBot] Skipping hidden conditional field:', step.label);
        notifyProgress(step, 'skipped');
        return { success: true, skipped: true, reason: 'field-hidden' };
      }

      // Scroll into view if needed
      const rect = el.getBoundingClientRect();
      if (rect.top < -50 || rect.bottom > window.innerHeight + 50) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' }); // FIX: instant
        await sleep(150);  // was 300
      }

      switch (step.action) {
        case 'type':
        case 'textarea':
          await executeType(el, step);
          break;
        case 'select':
          el.tagName.toLowerCase() === 'select'
            ? await executeSelect(el, step)
            : await executeCustomDropdown(step);
          // FIX: click visible Update/Save button that appears after dropdown change
          await autoClickUpdateButton(speed);
          break;
        case 'custom-select':
          await executeCustomDropdown(step);
          // FIX: click visible Update/Save button that appears after dropdown change
          await autoClickUpdateButton(speed);
          break;
        case 'checkbox':
          await executeCheckbox(el, step);
          break;
        case 'radio':
          highlight(el);
          await sleep(50);  // was 80
          if (!el.checked) simulateClick(el);
          break;
        case 'click':
        case 'click_button':
        default:
          await executeClick(el, step);
          break;
      }

      await smartWait(step, speed);
      notifyProgress(step, 'done');
      return { success: true };

    } catch (err) {
      console.error('[SmartBot] Step error:', step.action, step.label, err);
      notifyProgress(step, 'error');
      return { success: false, error: err.message };
    }
  }

  function notifyProgress(step, status) {
    window.dispatchEvent(new CustomEvent('smartbot:step_progress', {
      detail: { stepId: step.id, label: step.label, status }
    }));
  }

  // ── NEW: Stop execution cleanly ───────────────────────────
  function stop() {
    stopRequested = true;
  }

  // ── Run all steps ─────────────────────────────────────────
  // FIX: tighter inter-step delay floor; skipped steps get zero delay
  // NEW: checks stopRequested before every step
  async function run(steps, speed = 600) {
    if (isExecuting) return { success: false, error: 'Already executing' };
    isExecuting = true;
    stopRequested = false;

    await waitForPageLoad();
    const results = [];

    for (let i = 0; i < steps.length; i++) {
      // ── NEW: honour stop signal ───────────────────────────
      if (stopRequested) {
        window.dispatchEvent(new CustomEvent('smartbot:execution_stopped', { detail: { stoppedAt: i, results } }));
        isExecuting = false;
        return { success: false, stopped: true, results };
      }

      const step = steps[i];
      window.dispatchEvent(new CustomEvent('smartbot:progress', {
        detail: { current: i + 1, total: steps.length, step }
      }));

      const result = await executeStep(step, speed);
      results.push({ step, ...result });

      // FIX: skipped steps get no inter-step delay
      if (result.skipped) continue;

      const isSubmitLike = step.isSubmit || step.action === 'click_button';
      // FIX: floor reduced 150ms→80ms for non-submit steps
      // Also yield here so stop signal can be received during inter-step wait
      const waitMs = isSubmitLike ? speed : Math.max(speed * 0.3, 50);
      const chunkSize = 50;
      for (let waited = 0; waited < waitMs; waited += chunkSize) {
        if (stopRequested) break;
        await sleep(Math.min(chunkSize, waitMs - waited));
      }
    }

    if (!stopRequested) {
      // FIX: Wait for any pending re-render, then flush Required validation
      // errors so the form marks itself valid and enables the Update button.
      await waitForDomSettle(80, 300);
      nukeRequiredLabels();
      await sleep(80);
      nukeRequiredLabels();
      await sleep(80);

      // Snapshot all existing DOM nodes BEFORE clicking Update.
      // autoClickCloseButton uses this to only watch for NEWLY added nodes
      // (the success toast) — never confusing them with pre-existing elements
      // like the "Solar RT flag" chip-remove × button.
      const preUpdateNodes = new Set(document.body.querySelectorAll('*'));
      await autoClickUpdateButton(speed);
      await autoClickCloseButton(speed, preUpdateNodes);
    }

    isExecuting = false;
    const wasStopped = stopRequested;
    stopRequested = false;

    if (wasStopped) {
      window.dispatchEvent(new CustomEvent('smartbot:execution_stopped', { detail: { results } }));
      return { success: false, stopped: true, results };
    }

    window.dispatchEvent(new CustomEvent('smartbot:execution_complete', { detail: { results } }));
    return { success: true, results };
  }

  return { run, stop, isExecuting: () => isExecuting };
})();

// ── Message listener ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'EXECUTE_STEPS') {
    window.SmartExecutor.run(msg.steps, msg.speed || 600).then(sendResponse);
    return true;
  }
  // NEW: abort any in-progress execution immediately
  if (msg.type === 'STOP_EXECUTION') {
    window.SmartExecutor.stop();
    sendResponse({ success: true });
  }
  if (msg.type === 'START_RECORDING') {
    window.SmartRecorder.start();
    sendResponse({ success: true });
  }
  if (msg.type === 'STOP_RECORDING') {
    window.SmartRecorder.stop();
    sendResponse({ success: true });
  }
});
