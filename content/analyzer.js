// ============================================================
// SmartBot DOM Analyzer — Professional Edition v4.0
// ✦ High-accuracy label-based parameter auto-detection
// ✦ Multi-strategy selectors, shadow DOM, fuzzy scoring
// ✦ Mutation-aware label index for instant lookup
// ============================================================

window.SmartAnalyzer = (function () {

  // ── Cache for stable selectors (perf) ────────────────────
  const _selectorCache = new WeakMap();

  // ── Label index: normLabel → [elements] (rebuilt on DOM change) ──
  let _labelIndex = new Map();
  let _indexDirty = true;
  let _indexObserver = null;

  function _normLabel(s) {
    return String(s || '').toLowerCase().replace(/[*:]+$/, '').replace(/\s+/g, ' ').trim();
  }

  function _rebuildLabelIndex() {
    _labelIndex.clear();
    const interactives = document.querySelectorAll(
      'input:not([type="hidden"]), select, textarea, button, [role="combobox"], [role="listbox"], [role="button"], [tabindex]'
    );
    for (const el of interactives) {
      const lbl = getLabel(el);
      if (!lbl) continue;
      const key = _normLabel(lbl);
      if (!_labelIndex.has(key)) _labelIndex.set(key, []);
      _labelIndex.get(key).push(el);

      // Index sub-attributes separately too
      const extras = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id, el.getAttribute('data-testid')]
        .filter(Boolean).map(_normLabel);
      for (const extra of extras) {
        if (extra === key) continue;
        if (!_labelIndex.has(extra)) _labelIndex.set(extra, []);
        _labelIndex.get(extra).push(el);
      }
    }
    _indexDirty = false;
  }

  function _ensureIndex() { if (_indexDirty) _rebuildLabelIndex(); }

  function _startIndexObserver() {
    if (_indexObserver) return;
    _indexObserver = new MutationObserver(() => { _indexDirty = true; });
    _indexObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['id', 'name', 'placeholder', 'aria-label', 'aria-labelledby', 'data-testid']
    });
  }

  if (document.body) _startIndexObserver();
  else document.addEventListener('DOMContentLoaded', _startIndexObserver);

  // ── Shadow DOM traversal ──────────────────────────────────
  function queryShadow(root, selector) {
    try { const el = root.querySelector(selector); if (el) return el; } catch (_) {}
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) { const found = queryShadow(node.shadowRoot, selector); if (found) return found; }
    }
    return null;
  }

  // ── Custom-dropdown detection ─────────────────────────────
  function isCustomDropdown(el) {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'combobox' || role === 'listbox') return true;
    const ariaHasPopup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    if (['listbox', 'true', 'menu'].includes(ariaHasPopup)) return true;
    if (el.getAttribute('aria-expanded') !== null) return true;
    const cls = (el.className || '').toLowerCase();
    if (['select','dropdown','picker','combobox','chosen','select2','ant-select','rc-select','v-select','multiselect','autocomplete'].some(p => cls.includes(p))) return true;
    if (el.dataset?.toggle === 'dropdown' || el.dataset?.select) return true;
    return false;
  }

  // ── Generate ALL candidate selectors (ranked) ─────────────
  function getAllSelectors(el) {
    const c = [];
    if (el.id && !el.id.match(/^[0-9]/) && !el.id.match(/[:\[\]]/)) c.push({ type: 'id', priority: 100, selector: `#${CSS.escape(el.id)}` });
    if (el.getAttribute('data-testid')) c.push({ type: 'testid', priority: 95, selector: `[data-testid="${el.getAttribute('data-testid')}"]` });
    if (el.getAttribute('data-cy')) c.push({ type: 'cypress', priority: 94, selector: `[data-cy="${el.getAttribute('data-cy')}"]` });
    if (el.getAttribute('aria-label')) c.push({ type: 'aria-label', priority: 90, selector: `[aria-label="${el.getAttribute('aria-label')}"]` });
    if (el.name) c.push({ type: 'name', priority: 85, selector: `[name="${el.name}"]` });
    if (el.placeholder) c.push({ type: 'placeholder', priority: 80, selector: `[placeholder="${el.placeholder}"]` });
    if (el.getAttribute('data-id')) c.push({ type: 'data-id', priority: 75, selector: `[data-id="${el.getAttribute('data-id')}"]` });
    const cssPath = buildCSSPath(el);
    if (cssPath) c.push({ type: 'css', priority: 40, selector: cssPath });
    return c.sort((a, b) => b.priority - a.priority);
  }

  function getSelector(el) {
    if (_selectorCache.has(el)) return _selectorCache.get(el);
    const all = getAllSelectors(el);
    const best = all[0] || { type: 'css', selector: buildCSSPath(el), priority: 0 };
    _selectorCache.set(el, best);
    return best;
  }

  function buildCSSPath(el) {
    const parts = [];
    let current = el, depth = 0;
    while (current && current !== document.body && depth < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id && !current.id.match(/[:\[\]]/)) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
      const siblings = Array.from(current.parentNode?.children || []).filter(c => c.tagName === current.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = current.parentNode;
      depth++;
    }
    return parts.join(' > ');
  }

  // ── Human-readable label (multi-strategy) ─────────────────
  function getLabel(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const texts = labelledBy.split(' ').map(id => document.getElementById(id)?.innerText?.trim()).filter(Boolean);
      if (texts.length) return texts.join(' ');
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.innerText.replace(el.value || '', '').trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(n => n.remove());
      const txt = clone.innerText.trim();
      if (txt) return txt;
    }
    if (el.placeholder) return el.placeholder;
    if (el.title) return el.title;
    const prevText = getPrevText(el);
    if (prevText) return prevText;
    return el.name || el.id || el.tagName.toLowerCase();
  }

  function getPrevText(el) {
    let node = el.previousSibling, tries = 0;
    while (node && tries < 5) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return node.textContent.trim();
      if (node.nodeType === Node.ELEMENT_NODE && node.innerText?.trim()) return node.innerText.trim().slice(0, 80);
      node = node.previousSibling; tries++;
    }
    if (el.parentElement) {
      const parentPrev = el.parentElement.previousElementSibling;
      if (parentPrev) return parentPrev.innerText?.trim().slice(0, 80) || '';
    }
    return '';
  }

  // ── Element type classification ───────────────────────────
  function classifyElement(el) {
    const tag = el.tagName.toLowerCase(), type = (el.type || '').toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'range') return 'range';
      if (type === 'file') return 'file';
      return 'input';
    }
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (el.getAttribute('role') === 'button') return 'button';
    if (el.getAttribute('role') === 'option') return 'option';
    if (el.isContentEditable) return 'contenteditable';
    if (isCustomDropdown(el)) return 'custom-select';
    return 'click';
  }

  function isSubmitButton(el) {
    const tag = el.tagName.toLowerCase(), type = (el.type || '').toLowerCase();
    const text = (el.innerText || el.value || '').toLowerCase();
    const submitWords = ['submit','save','update','send','confirm','apply','ok','done','next','continue','proceed','login','sign in','register','create','finish'];
    if (type === 'submit') return true;
    if (tag === 'button' || tag === 'input') return submitWords.some(w => text.includes(w));
    return false;
  }

  // ── Full element context for recording ────────────────────
  function analyzeElement(el) {
    const rect = el.getBoundingClientRect();
    const scrollY = window.scrollY;
    const allSelectors = getAllSelectors(el);
    return {
      selector: allSelectors[0] || { type: 'css', selector: buildCSSPath(el) },
      allSelectors,
      label: getLabel(el),
      elementType: classifyElement(el),
      isSubmit: isSubmitButton(el),
      tagName: el.tagName.toLowerCase(),
      inputType: el.type || null,
      placeholder: el.placeholder || null,
      name: el.name || null,
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      dataTestId: el.getAttribute('data-testid') || null,
      rect: { top: rect.top + scrollY, left: rect.left, width: rect.width, height: rect.height },
      scrollY,
      formId: el.form?.id || el.closest('form')?.id || null,
      formAction: el.form?.action || el.closest('form')?.action || null,
      currentValue: getElementValue(el),
      xpath: getXPath(el),
    };
  }

  function getElementValue(el) {
    if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text || el.value;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    return el.value || el.innerText || '';
  }

  function getXPath(el) {
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let idx = 0, sib = current.previousSibling;
      while (sib) { if (sib.nodeType === Node.ELEMENT_NODE && sib.tagName === current.tagName) idx++; sib = sib.previousSibling; }
      parts.unshift(`${current.tagName.toLowerCase()}[${idx + 1}]`);
      current = current.parentNode;
    }
    return '/' + parts.join('/');
  }

  function scanPageStructure() {
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id, action: f.action,
      fields: Array.from(f.querySelectorAll('input, select, textarea, button')).map(el => ({
        label: getLabel(el), type: classifyElement(el), name: el.name, id: el.id,
      }))
    }));
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({ label: getLabel(el), type: classifyElement(el), name: el.name, id: el.id }));
    return { forms, inputs, url: location.href, title: document.title };
  }

  // ══════════════════════════════════════════════════════════
  // ✦  HIGH-ACCURACY LABEL-BASED PARAMETER DETECTION  v4.0  ✦
  //
  // Scoring matrix:
  //   EXACT match on label               → 1000
  //   Exact match on a sub-attribute     → 800
  //   One string starts with the other   → 600
  //   One contains the other             → 400
  //   All tokens match                   → 300
  //   Some tokens match (weighted)       → 0-150
  //   Corroborating signals (bonuses):
  //     label[for] exact                 → +72
  //     aria-label exact                 → +65
  //     placeholder exact                → +50
  //     name exact                       → +40
  //     data-testid exact                → +73
  //     visible in viewport              → +8
  //     interactive & enabled            → +10
  //     form element type                → +15
  //   Penalties:
  //     hidden / disabled                → -50
  //   Tiebreak: highest total score wins
  // ══════════════════════════════════════════════════════════

  function detectByLabel(labelText) {
    if (!labelText) return null;
    _ensureIndex();

    const query = _normLabel(labelText);
    if (!query) return null;
    const queryTokens = query.split(' ').filter(t => t.length > 1);
    const candidateSet = new Map(); // el → baseScore

    for (const [key, els] of _labelIndex) {
      let score = 0;
      if (key === query)                              score = 1000;
      else if (key.startsWith(query)||query.startsWith(key)) score = 600;
      else if (key.includes(query) || query.includes(key))   score = 400;
      else {
        const kt = key.split(' ').filter(t => t.length > 1);
        const hits = queryTokens.filter(t => kt.includes(t)).length;
        if (hits === queryTokens.length && hits > 0) score = 300;
        else if (hits > 0) score = Math.round(150 * hits / queryTokens.length);
      }
      if (score > 0) for (const el of els) {
        const cur = candidateSet.get(el) || 0;
        candidateSet.set(el, Math.max(cur, score));
      }
    }

    // Direct attr scan (catches freshly-added elements)
    const directAttrs = [
      `[aria-label="${labelText}"]`, `[placeholder="${labelText}"]`,
      `[name="${labelText}"]`, `[data-testid="${labelText}"]`,
    ];
    for (const sel of directAttrs) {
      try { const el = document.querySelector(sel); if (el) candidateSet.set(el, Math.max(candidateSet.get(el)||0, 800)); } catch (_) {}
    }

    const scored = [];
    for (const [el, base] of candidateSet) {
      if (!isVisible(el)) continue;
      let s = base;

      // label[for] signal
      if (el.id) {
        const fl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (fl) {
          const ft = _normLabel(fl.innerText);
          if (ft === query) s += 72;
          else if (ft.includes(query)||query.includes(ft)) s += 35;
        }
      }
      const ai = _normLabel(el.getAttribute('aria-label')||''); if (ai===query) s+=65; else if(ai&&(ai.includes(query)||query.includes(ai))) s+=28;
      const ph = _normLabel(el.placeholder||'');                if (ph===query) s+=50; else if(ph&&(ph.includes(query)||query.includes(ph))) s+=20;
      const nm = _normLabel(el.name||'');                       if (nm===query) s+=40; else if(nm&&(nm.includes(query)||query.includes(nm))) s+=15;
      const td = _normLabel(el.getAttribute('data-testid')||''); if(td===query) s+=73; else if(td&&(td.includes(query)||query.includes(td))) s+=30;

      if (!el.disabled && !el.readOnly) s += 10;
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0 && rect.bottom <= window.innerHeight) s += 8;
      if (['input','select','textarea'].includes(el.tagName.toLowerCase())) s += 15;
      if (el.hidden || el.disabled) s -= 50;

      scored.push({ el, score: s });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0].el;
  }

  /**
   * autoDetectStepParameters(step)
   * Unified detection: hard selectors first, then label-based scoring.
   * Returns { el, confidence, method }.
   */
  function autoDetectStepParameters(step) {
    const label = step.label;

    // Pass 1 — hard identifiers (highest confidence, fastest)
    if (step.dataTestId) {
      const el = document.querySelector(`[data-testid="${step.dataTestId}"]`);
      if (isVisible(el)) return { el, confidence: 1.0, method: 'data-testid' };
    }
    if (step.id) {
      const el = document.getElementById(step.id);
      if (isVisible(el)) return { el, confidence: 0.97, method: 'id' };
    }
    if (step.ariaLabel) {
      const el = document.querySelector(`[aria-label="${step.ariaLabel}"]`);
      if (isVisible(el)) return { el, confidence: 0.92, method: 'aria-label' };
    }
    if (step.name && step.formId) {
      const el = document.querySelector(`#${step.formId} [name="${step.name}"]`) || document.querySelector(`[name="${step.name}"]`);
      if (isVisible(el)) return { el, confidence: 0.93, method: 'name+form' };
    }
    if (step.name) {
      const el = document.querySelector(`[name="${step.name}"]`);
      if (isVisible(el)) return { el, confidence: 0.88, method: 'name' };
    }
    if (step.placeholder) {
      const el = document.querySelector(`[placeholder="${step.placeholder}"]`);
      if (isVisible(el)) return { el, confidence: 0.85, method: 'placeholder' };
    }

    // Pass 2 — all recorded selectors
    let best = null, method = null, confidence = 0;
    if (step.allSelectors?.length) {
      for (const s of step.allSelectors) {
        try {
          const el = document.querySelector(s.selector);
          if (isVisible(el)) { best = el; method = `selector:${s.type}`; confidence = 0.72 + s.priority / 1000; break; }
        } catch (_) {}
      }
    }

    // Pass 3 — main selector
    if (!best && step.selector?.selector) {
      try { const el = document.querySelector(step.selector.selector); if (isVisible(el)) { best = el; method = 'selector'; confidence = 0.70; } } catch (_) {}
    }

    // Pass 4 — XPath
    if (!best && step.xpath) {
      try {
        const r = document.evaluate(step.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const el = r.singleNodeValue; if (isVisible(el)) { best = el; method = 'xpath'; confidence = 0.68; }
      } catch (_) {}
    }

    // Pass 5 — shadow DOM
    if (!best && step.id) {
      const el = queryShadow(document.body, `#${CSS.escape(step.id)}`);
      if (isVisible(el)) { best = el; method = 'shadow-dom'; confidence = 0.80; }
    }

    // Pass 6 — label-based smart detection (existing fuzzy scorer)
    if (label) {
      const labelEl = detectByLabel(label);
      if (labelEl) {
        if (!best) {
          best = labelEl; method = 'label-detect'; confidence = 0.82;
        } else if (labelEl === best) {
          confidence = Math.min(1.0, confidence + 0.12); method += '+label';
        } else {
          const labelType = classifyElement(labelEl);
          const stepType  = step.elementType || step.action || '';
          const typeOK = labelType === stepType
            || (labelType === 'input'  && ['type','textarea'].includes(stepType))
            || (labelType === 'select' && stepType.includes('select'));
          if (typeOK) { best = labelEl; method = 'label-detect(override)'; confidence = 0.79; }
        }
      }
    }

    // Pass 7 — LabelScanner fingerprint resolution (highest accuracy)
    // Uses the full label fingerprint embedded at record time to re-find
    // the field in the current DOM with multi-signal scoring.
    // ── Confidence guard: if fingerprint confidence ≥ 0.90 it ALWAYS
    //    wins over a selector-only result below 0.85 to prevent stale
    //    CSS paths pointing at the wrong field after DOM rebuilds.
    if (window.SmartLabelScanner && step.labelFingerprint) {
      try {
        const fpEl = window.SmartLabelScanner.resolveStep(step);
        if (fpEl && isVisible(fpEl)) {
          const fpConf = 0.95;   // fingerprint is our highest-signal pass
          if (!best) {
            best = fpEl; method = 'fingerprint'; confidence = fpConf;
          } else if (fpEl === best) {
            confidence = Math.min(1.0, confidence + 0.08); method += '+fingerprint';
          } else {
            // Type corroboration check
            const fpType   = classifyElement(fpEl);
            const stepType = step.elementType || step.action || '';
            const typeMatch = fpType === stepType
              || (fpType === 'input'  && ['type','textarea'].includes(stepType))
              || (fpType === 'select' && stepType.includes('select'))
              || (fpType === 'custom-select' && stepType.includes('select'));
            // Override stale selector if fingerprint type matches AND
            // fingerprint confidence outscores the current best by threshold
            if (typeMatch && fpConf > confidence + 0.08) {
              best = fpEl; method = 'fingerprint(override)'; confidence = fpConf;
            } else if (typeMatch) {
              best = fpEl; method = 'fingerprint(override)'; confidence = fpConf;
            }
          }
        }
      } catch (_) {}
    }

    if (!best) return { el: null, confidence: 0, method: 'not-found' };
    return { el: best, confidence, method };
  }

  // ── Smart element finder ─────────────────────────────────
  function findElement(step, label) {
    const merged = { ...step, label: label || step.label };
    const result = autoDetectStepParameters(merged);
    if (result.el) {
      if (window.__smartbotDebug) console.log(`[SmartBot] findElement: ${result.method} conf=${(result.confidence*100).toFixed(0)}%`, result.el);
      return result.el;
    }
    if (label || step.label) return detectByLabel(label || step.label);
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return !!(el.offsetParent !== null || (rect.width > 0 && rect.height > 0));
  }

  function findByLabel(labelText) {
    return detectByLabel(labelText);
  }

  return {
    analyzeElement, getLabel, getSelector, getAllSelectors,
    classifyElement, isSubmitButton, scanPageStructure,
    findElement, isCustomDropdown, isVisible, queryShadow,
    detectByLabel, autoDetectStepParameters,
    rebuildLabelIndex: _rebuildLabelIndex,
  };
})();
