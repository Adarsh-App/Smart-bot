// ============================================================
// SmartBot MacroAnalyzer — v9.0
// ✦ Human-precision full-page parameter scanner
// ✦ Captures EVERY label/field relationship at record time
// ✦ Builds a deep PageMap: form groups, sections, tab panels
// ✦ Resolves any field with 100% accuracy at playback via
//   multi-strategy ranked search — exact → fuzzy → structural
// ✦ Handles SPA re-renders, dynamic forms, conditional fields
// ============================================================

window.SmartMacroAnalyzer = (function () {

  // ══════════════════════════════════════════════════════════
  // 1. NORMALISATION HELPERS
  // ══════════════════════════════════════════════════════════

  const STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being','of','in','on','at','to','for','with','by','from','up','about','into','through','during','including','until','against','among','throughout','despite','towards','upon','and','or','but','if','then','so','because','as','while','although','whether','yet','nor','not','also','just','very','too','even','still','only','both','each','more','most','other','some','such','no','than','that','this','these','those']);

  function normStr(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[*:\u200b\u00a0\uFEFF]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenise(s) {
    return normStr(s)
      .split(/[\s\-_/|]+/)
      .filter(t => t.length > 1 && !STOP_WORDS.has(t));
  }

  function norm(s) {
    return normStr(s).replace(/[^a-z0-9]/g, '');
  }

  // ══════════════════════════════════════════════════════════
  // 2. DEEP PAGE MAP — built once per recording start, updated
  //    on every MutationObserver callback
  // ══════════════════════════════════════════════════════════

  // Internal map: fieldKey → FieldEntry
  // fieldKey = normStr(primaryLabel) or id or name
  let _pageMap = new Map();
  let _pageMapDirty = true;
  let _mutationObserver = null;

  /**
   * FieldEntry shape:
   * {
   *   el,           // live DOM reference
   *   primaryLabel, // best human-readable label
   *   allLabels,    // all candidate label strings
   *   labelNorm,
   *   labelTokens,
   *   sectionLabel, // nearest section/fieldset/accordion heading
   *   groupLabel,   // nearest form-group / .field-row label
   *   tabLabel,     // nearest tab-panel label (for tabbed UIs)
   *   tagName,
   *   inputType,
   *   id, name,
   *   ariaLabel,
   *   placeholder,
   *   dataTestId,
   *   formId,
   *   domOrder,      // index among all fields (stable ordering)
   *   pageRatio,     // vertical position as 0-1 fraction
   *   options,       // for <select>: [{value,text}]
   *   isVisible,
   *   isRequired,
   * }
   */

  // ── 2a. Collect all interactive fields ───────────────────
  const FIELD_SELECTOR = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
    'select',
    'textarea',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="switch"]',
    '[role="spinbutton"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[contenteditable="true"]',
  ].join(', ');

  function collectAllFields() {
    return Array.from(document.querySelectorAll(FIELD_SELECTOR));
  }

  // ── 2b. Visibility check ──────────────────────────────────
  function isVisible(el) {
    if (!el) return false;
    if (el.hidden || el.disabled) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    let node = el;
    while (node && node !== document.body) {
      const s = window.getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      if (node.getAttribute('aria-hidden') === 'true') return false;
      node = node.parentElement;
    }
    return true;
  }

  // ── 2c. Section/group/tab context extraction ─────────────
  function extractContext(el) {
    // Find nearest section heading (h1-h6, legend, [aria-label] on section/fieldset)
    let sectionLabel = '';
    let node = el.parentElement;
    while (node && node !== document.body) {
      // Fieldset legend
      if (node.tagName === 'FIELDSET') {
        const legend = node.querySelector(':scope > legend');
        if (legend) { sectionLabel = legend.innerText?.trim() || ''; break; }
      }
      // aria-label / aria-labelledby on section/article/div[role]
      const nodeRole = node.getAttribute('role') || '';
      if (['group','region','tabpanel','dialog','form','section'].includes(nodeRole)) {
        const lbl = node.getAttribute('aria-label') || '';
        const lbBy = node.getAttribute('aria-labelledby') || '';
        if (lbl) { sectionLabel = lbl; break; }
        if (lbBy) {
          const txt = lbBy.split(' ').map(id => document.getElementById(id)?.innerText?.trim()).filter(Boolean).join(' ');
          if (txt) { sectionLabel = txt; break; }
        }
      }
      // Look for preceding heading sibling
      const headings = node.querySelectorAll(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6');
      if (headings.length) { sectionLabel = headings[headings.length - 1].innerText?.trim() || ''; break; }
      node = node.parentElement;
    }

    // Find nearest tab-panel label
    let tabLabel = '';
    const panel = el.closest('[role="tabpanel"]');
    if (panel) {
      const panelId = panel.id;
      if (panelId) {
        const tabBtn = document.querySelector(`[aria-controls="${panelId}"]`);
        if (tabBtn) tabLabel = tabBtn.innerText?.trim() || '';
      }
      if (!tabLabel) tabLabel = panel.getAttribute('aria-label') || '';
    }

    // Nearest form-group label
    let groupLabel = '';
    const group = el.closest('.form-group, .field-row, .form-field, .input-group, .form-row, [class*="field"], [class*="form-item"]');
    if (group) {
      const lbl = group.querySelector('label, .label, .field-label, .form-label, th, dt');
      if (lbl && !lbl.contains(el)) groupLabel = lbl.innerText?.trim().slice(0, 120) || '';
    }

    return { sectionLabel, tabLabel, groupLabel };
  }

  // ── 2d. Extract all label candidates for a field ─────────
  function extractAllLabels(el) {
    const candidates = [];

    // Priority 1: aria-labelledby
    const lbBy = el.getAttribute('aria-labelledby');
    if (lbBy) {
      const txt = lbBy.split(/\s+/)
        .map(id => document.getElementById(id)?.innerText?.trim())
        .filter(Boolean).join(' ');
      if (txt) candidates.push({ text: txt, source: 'aria-labelledby', weight: 100 });
    }

    // Priority 2: aria-label
    const ariaLbl = el.getAttribute('aria-label');
    if (ariaLbl?.trim()) candidates.push({ text: ariaLbl.trim(), source: 'aria-label', weight: 95 });

    // Priority 3: <label for="id">
    if (el.id) {
      const forLbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLbl) {
        const clone = forLbl.cloneNode(true);
        clone.querySelectorAll('input,select,textarea,button,span.asterisk,span.required,[aria-hidden]').forEach(n => n.remove());
        const txt = clone.innerText?.trim();
        if (txt) candidates.push({ text: txt, source: 'label-for', weight: 90 });
      }
    }

    // Priority 4: wrapping <label>
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,button,span.asterisk,span.required,[aria-hidden]').forEach(n => n.remove());
      const txt = clone.innerText?.trim();
      if (txt) candidates.push({ text: txt, source: 'wrapping-label', weight: 85 });
    }

    // Priority 5: Preceding sibling text (up to 4 nodes back)
    const prevTxt = getPrevSiblingText(el, 4);
    if (prevTxt) candidates.push({ text: prevTxt, source: 'prev-sibling', weight: 75 });

    // Priority 6: Parent's preceding sibling (grid/table layout)
    if (el.parentElement) {
      const pp = el.parentElement.previousElementSibling;
      if (pp && !pp.querySelector('input,select,textarea')) {
        const txt = pp.innerText?.trim().slice(0, 120);
        if (txt) candidates.push({ text: txt, source: 'parent-prev', weight: 65 });
      }
    }

    // Priority 7: Placeholder
    if (el.placeholder?.trim()) candidates.push({ text: el.placeholder.trim(), source: 'placeholder', weight: 55 });

    // Priority 8: title attribute
    if (el.title?.trim()) candidates.push({ text: el.title.trim(), source: 'title', weight: 50 });

    // Priority 9: name attribute (formatted)
    if (el.name) {
      const pretty = el.name.replace(/[_\-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      candidates.push({ text: pretty, source: 'name', weight: 30 });
    }

    // Priority 10: id attribute (formatted)
    if (el.id) {
      const pretty = el.id.replace(/[_\-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      candidates.push({ text: pretty, source: 'id', weight: 25 });
    }

    // Deduplicate by normalised text
    const seen = new Set();
    return candidates.filter(c => {
      const k = normStr(c.text);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function getPrevSiblingText(el, maxLook = 4) {
    let node = el.previousSibling, count = 0;
    while (node && count < maxLook) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        return node.textContent.trim().slice(0, 120);
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName?.toLowerCase();
        if (!['script','style','svg','img'].includes(tag)) {
          const txt = node.innerText?.trim();
          if (txt) return txt.slice(0, 120);
        }
      }
      node = node.previousSibling;
      count++;
    }
    // Try parent-level prev sibling as last resort
    if (el.parentElement) {
      let p = el.parentElement;
      for (let i = 0; i < 3; i++) {
        const prev = p.previousElementSibling;
        if (prev && !prev.querySelector('input,select,textarea')) {
          const txt = prev.innerText?.trim().slice(0, 120);
          if (txt) return txt;
        }
        p = p.parentElement;
        if (!p || p === document.body) break;
      }
    }
    return '';
  }

  // ── 2e. Build full FieldEntry for one element ─────────────
  function buildFieldEntry(el, domOrder) {
    const labelCandidates = extractAllLabels(el);
    const primaryCandidate = labelCandidates[0] || null;
    const primaryLabel = primaryCandidate?.text || el.name || el.id || el.tagName.toLowerCase();
    const { sectionLabel, tabLabel, groupLabel } = extractContext(el);

    const rect = el.getBoundingClientRect();
    const scrollH = Math.max(document.body.scrollHeight, 1);
    const pageRatio = parseFloat(((rect.top + window.scrollY) / scrollH).toFixed(4));

    // Collect options for <select>
    let options = null;
    if (el.tagName === 'SELECT') {
      options = Array.from(el.options)
        .filter(o => o.value !== '')
        .map(o => ({ value: o.value, text: o.text.trim() }));
    }

    return {
      el,
      primaryLabel,
      allLabels: labelCandidates.map(c => c.text),
      labelSources: labelCandidates.map(c => c.source),
      labelNorm: normStr(primaryLabel),
      labelTokens: tokenise(primaryLabel),
      sectionLabel,
      tabLabel,
      groupLabel,
      tagName: el.tagName.toLowerCase(),
      inputType: el.type || null,
      id: el.id || null,
      name: el.name || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      placeholder: el.placeholder || null,
      dataTestId: el.getAttribute('data-testid') || null,
      formId: el.form?.id || el.closest('form')?.id || null,
      domOrder,
      pageRatio,
      options,
      isVisible: isVisible(el),
      isRequired: el.required || el.getAttribute('aria-required') === 'true',
    };
  }

  // ── 2f. Rebuild the full page map ─────────────────────────
  function rebuildPageMap() {
    _pageMap.clear();
    const fields = collectAllFields();
    fields.forEach((el, idx) => {
      const entry = buildFieldEntry(el, idx);
      // Index by every label candidate for fast lookup
      entry.allLabels.forEach(lbl => {
        const key = normStr(lbl);
        if (key) _pageMap.set(key, entry);
      });
      // Also index by id and name
      if (entry.id) _pageMap.set(normStr(entry.id), entry);
      if (entry.name) _pageMap.set(normStr(entry.name), entry);
    });
    _pageMapDirty = false;
  }

  function ensurePageMap() {
    if (_pageMapDirty) rebuildPageMap();
  }

  // ── 2g. Start MutationObserver to track DOM changes ──────
  function startObserver() {
    if (_mutationObserver) return;
    _mutationObserver = new MutationObserver(() => { _pageMapDirty = true; });
    _mutationObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id','name','placeholder','aria-label','aria-labelledby','data-testid','aria-hidden','hidden','disabled','style','class'],
    });
  }

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  // ══════════════════════════════════════════════════════════
  // 3. DEEP FIELD FINGERPRINT
  //    Stored in every recorded step for 100% playback accuracy
  // ══════════════════════════════════════════════════════════

  function buildDeepFingerprint(el) {
    ensurePageMap();
    const labelCandidates = extractAllLabels(el);
    const primary = labelCandidates[0]?.text || el.name || el.id || '';
    const { sectionLabel, tabLabel, groupLabel } = extractContext(el);

    const rect = el.getBoundingClientRect();
    const scrollH = Math.max(document.body.scrollHeight, 1);
    const allFields = collectAllFields();
    const domOrder = allFields.indexOf(el);

    return {
      // === LABEL SIGNALS (primary resolution path) ===
      primaryLabel:     primary,
      allLabels:        labelCandidates.map(c => c.text),
      labelSources:     labelCandidates.map(c => c.source),
      labelNorm:        normStr(primary),
      labelTokens:      tokenise(primary),

      // === CONTEXT SIGNALS (disambiguate same-name fields) ===
      sectionLabel,
      sectionLabelNorm: normStr(sectionLabel),
      tabLabel,
      tabLabelNorm:     normStr(tabLabel),
      groupLabel,
      groupLabelNorm:   normStr(groupLabel),

      // === HARD IDENTIFIERS (fast exact match) ===
      id:          el.id || null,
      name:        el.name || null,
      ariaLabel:   el.getAttribute('aria-label') || null,
      dataTestId:  el.getAttribute('data-testid') || null,
      placeholder: el.placeholder || null,
      formId:      el.form?.id || el.closest('form')?.id || null,

      // === STRUCTURAL SIGNALS ===
      tagName:    el.tagName.toLowerCase(),
      inputType:  el.type || null,
      domOrder,
      pageRatio:  parseFloat(((rect.top + window.scrollY) / scrollH).toFixed(4)),
      totalFieldsOnPage: allFields.length,

      // === DROPDOWN OPTIONS SNAPSHOT ===
      // Stored at record-time; used for cross-validation at playback
      recordedOptions: el.tagName === 'SELECT'
        ? Array.from(el.options).filter(o => o.value !== '').map(o => ({ value: o.value, text: o.text.trim() }))
        : null,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 4. RESOLUTION ENGINE
  //    Find the best DOM element for a recorded fingerprint.
  //    Uses a 12-signal scoring system, highest wins.
  //    Designed to work even when IDs / CSS paths change.
  // ══════════════════════════════════════════════════════════

  /**
   * Score table:
   *  primaryLabel exact (norm)         1000
   *  primaryLabel starts-with          750
   *  primaryLabel contains             500
   *  all tokens match                  450
   *  partial token overlap             1-200
   *  any allLabels exact               +900 (bonus)
   *  id match                          +600
   *  data-testid match                 +600
   *  name match                        +400
   *  aria-label match                  +400
   *  placeholder match                 +200
   *  sectionLabel fuzzy bonus          +100
   *  tabLabel fuzzy bonus              +80
   *  same tagName                      +80
   *  same inputType                    +40
   *  same form                         +60
   *  position proximity (4 bands)      +10..40
   *  domOrder proximity                +10..30
   *  visible + enabled                 +20
   */
  function resolveByFingerprint(fp, fallbackLabel) {
    if (!fp && !fallbackLabel) return null;

    ensurePageMap();

    const queryNorm   = fp?.labelNorm  || normStr(fallbackLabel);
    const queryTokens = fp?.labelTokens || tokenise(fallbackLabel || '');
    const allCandidates = collectAllFields();

    // === Fast path: exact pageMap lookup ===
    if (_pageMap.has(queryNorm)) {
      const entry = _pageMap.get(queryNorm);
      if (entry && isVisible(entry.el)) {
        // Still run full scoring if ambiguous (multiple fields could share key)
        // but return immediately if this is the only one
        const dupCheck = allCandidates.filter(el => {
          const { allLabels } = { allLabels: extractAllLabels(el).map(c => c.text) };
          return allLabels.some(l => normStr(l) === queryNorm);
        });
        if (dupCheck.length === 1) return entry.el;
      }
    }

    // === Full scoring pass ===
    const scored = [];

    for (const el of allCandidates) {
      const elLabels = extractAllLabels(el).map(c => c.text);
      let score = 0;

      // ── Label scoring ─────────────────────────────────────
      let bestLabelScore = 0;
      for (const rawLbl of elLabels) {
        const n = normStr(rawLbl);
        const tok = tokenise(rawLbl);
        let s = 0;

        if (n === queryNorm) {
          s = 1000;
        } else if (n.startsWith(queryNorm) || queryNorm.startsWith(n)) {
          s = 750;
        } else if (n.includes(queryNorm) || queryNorm.includes(n)) {
          s = 500;
        } else {
          const hits = queryTokens.filter(t => tok.includes(t)).length;
          const normHits = queryTokens.filter(t => tok.some(ot => norm(ot) === norm(t))).length;
          const hitsMax = Math.max(hits, normHits);
          if (hitsMax === queryTokens.length && hitsMax > 0) s = 450;
          else if (hitsMax > 0) s = Math.round(200 * hitsMax / Math.max(queryTokens.length, tok.length, 1));
        }
        if (s > bestLabelScore) bestLabelScore = s;
      }

      if (bestLabelScore === 0) continue; // no label relevance at all
      score += bestLabelScore;

      // ── All-labels bonus ──────────────────────────────────
      if (fp?.allLabels) {
        for (const recLbl of fp.allLabels) {
          const rn = normStr(recLbl);
          if (elLabels.some(l => normStr(l) === rn)) {
            score += 900;
            break;
          }
        }
      }

      // ── Hard identifier bonuses ───────────────────────────
      if (fp) {
        if (fp.id        && el.id                              === fp.id)           score += 600;
        if (fp.dataTestId && el.getAttribute('data-testid')   === fp.dataTestId)   score += 600;
        if (fp.name      && el.name                           === fp.name)         score += 400;
        if (fp.ariaLabel && el.getAttribute('aria-label')     === fp.ariaLabel)    score += 400;
        if (fp.placeholder && el.placeholder                  === fp.placeholder)  score += 200;

        // ── Structural bonuses ────────────────────────────────
        if (fp.tagName   && el.tagName.toLowerCase() === fp.tagName) score += 80;
        if (fp.inputType && el.type                  === fp.inputType) score += 40;

        const elFormId = el.form?.id || el.closest('form')?.id || null;
        if (fp.formId && elFormId && fp.formId === elFormId) score += 60;

        // ── Context bonuses (section / tab) ───────────────────
        if (fp.sectionLabelNorm) {
          const { sectionLabel } = extractContext(el);
          const sn = normStr(sectionLabel);
          if (sn && sn === fp.sectionLabelNorm) score += 100;
          else if (sn && (sn.includes(fp.sectionLabelNorm) || fp.sectionLabelNorm.includes(sn))) score += 50;
        }
        if (fp.tabLabelNorm) {
          const { tabLabel } = extractContext(el);
          const tn = normStr(tabLabel);
          if (tn && tn === fp.tabLabelNorm) score += 80;
        }

        // ── Position proximity bonus ──────────────────────────
        if (fp.pageRatio !== null && fp.pageRatio !== undefined) {
          const rect = el.getBoundingClientRect();
          const scrollH = Math.max(document.body.scrollHeight, 1);
          const ratio = parseFloat(((rect.top + window.scrollY) / scrollH).toFixed(4));
          const diff = Math.abs(ratio - fp.pageRatio);
          if      (diff < 0.005) score += 40;
          else if (diff < 0.02)  score += 25;
          else if (diff < 0.05)  score += 10;
        }

        // ── DOM order proximity ────────────────────────────────
        if (fp.domOrder !== undefined && fp.domOrder !== null) {
          const currentOrder = allCandidates.indexOf(el);
          const orderDiff = Math.abs(currentOrder - fp.domOrder);
          if      (orderDiff === 0) score += 30;
          else if (orderDiff <= 2)  score += 20;
          else if (orderDiff <= 5)  score += 10;
        }
      }

      // ── Visibility / enabled bonus ────────────────────────
      if (!el.disabled && !el.readOnly && isVisible(el)) score += 20;

      scored.push({ el, score });
    }

    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);

    if (window.__smartbotDebug) {
      const top3 = scored.slice(0, 3).map(x => {
        const lbl = extractAllLabels(x.el)[0]?.text || x.el.name || x.el.id || '?';
        return `"${lbl}" (${x.score})`;
      });
      console.log(`[MacroAnalyzer] resolve "${queryNorm}" → top3:`, top3.join(' | '));
    }

    // Return winner only if score is meaningful (>= 100 avoids false positives)
    return scored[0].score >= 100 ? scored[0].el : null;
  }

  // ══════════════════════════════════════════════════════════
  // 5. DROPDOWN OPTION RESOLVER
  //    Finds the best-matching option across ALL dropdown types:
  //    native <select>, ARIA listbox, custom UI libraries.
  //    Uses a 6-tier strategy, logging confidence at each level.
  // ══════════════════════════════════════════════════════════

  /**
   * Given a target text/value and a list of option elements or
   * {text, value} objects, returns the best match using ranked scoring.
   */
  function resolveDropdownOption(targetText, targetValue, optionElements) {
    if (!optionElements || optionElements.length === 0) return null;

    const tTxt  = (targetText  || '').trim();
    const tVal  = (targetValue || '').trim();
    const tTxtN = normStr(tTxt);
    const tValN = normStr(tVal);
    const tTxtNorm = norm(tTxt);
    const tTok  = tokenise(tTxt);

    function scoreOne(rawText, rawValue) {
      const oTxt  = (rawText  || '').trim();
      const oVal  = (rawValue || '').trim();
      const oTxtN = normStr(oTxt);
      const oValN = normStr(oVal);
      const oTxtNorm = norm(oTxt);
      const oTok  = tokenise(oTxt);
      let s = 0;

      // Text-based tiers (primary signal)
      if (oTxt  === tTxt)                          s = Math.max(s, 1000);
      else if (oTxtN === tTxtN)                    s = Math.max(s, 950);
      else if (oTxtNorm === tTxtNorm)              s = Math.max(s, 900);
      else if (oTxtN.startsWith(tTxtN) || tTxtN.startsWith(oTxtN)) s = Math.max(s, 700);
      else if (oTxtN.includes(tTxtN)   || tTxtN.includes(oTxtN))   s = Math.max(s, 500);
      else {
        const hits = tTok.filter(t => oTok.some(ot => norm(ot) === norm(t) || ot.includes(t) || t.includes(ot))).length;
        if (hits === tTok.length && hits > 0) s = Math.max(s, 400);
        else if (hits > 0) s = Math.max(s, Math.round(200 * hits / Math.max(tTok.length, oTok.length, 1)));
      }

      // Value-based bonuses
      if (oVal === tVal && tVal)    s += 300;
      else if (oValN === tValN && tValN) s += 200;

      return s;
    }

    const scored = optionElements.map(item => {
      let rawText, rawValue, el;
      if (item && typeof item === 'object' && 'nodeType' in item) {
        // DOM element
        rawText  = item.textContent?.trim() || item.innerText?.trim() || '';
        rawValue = item.dataset?.value || item.getAttribute('value') || item.getAttribute('data-key') || rawText;
        el = item;
      } else {
        // Plain {text, value} object
        rawText  = item.text  || '';
        rawValue = item.value || '';
        el = null;
      }
      return { el, rawText, rawValue, score: scoreOne(rawText, rawValue) };
    }).filter(x => x.score > 0);

    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);

    if (window.__smartbotDebug) {
      const top3 = scored.slice(0, 3).map(x => `"${x.rawText}" (${x.score})`);
      console.log(`[MacroAnalyzer] dropdown resolve "${tTxt}" → top3:`, top3.join(' | '));
    }

    const winner = scored[0];
    return { el: winner.el, text: winner.rawText, value: winner.rawValue, score: winner.score };
  }

  // ══════════════════════════════════════════════════════════
  // 6. FULL PAGE SNAPSHOT (used by recorder at start)
  //    Returns structured overview: sections → fields
  // ══════════════════════════════════════════════════════════

  function snapshotPage() {
    ensurePageMap();
    const fields = collectAllFields();
    const snapshot = {
      url:        location.href,
      title:      document.title,
      capturedAt: Date.now(),
      fieldCount: fields.length,
      fields: fields.map((el, idx) => {
        const entry = buildFieldEntry(el, idx);
        return {
          index:        entry.domOrder,
          primaryLabel: entry.primaryLabel,
          allLabels:    entry.allLabels,
          sectionLabel: entry.sectionLabel,
          tabLabel:     entry.tabLabel,
          groupLabel:   entry.groupLabel,
          tagName:      entry.tagName,
          inputType:    entry.inputType,
          id:           entry.id,
          name:         entry.name,
          placeholder:  entry.placeholder,
          dataTestId:   entry.dataTestId,
          isVisible:    entry.isVisible,
          isRequired:   entry.isRequired,
          options:      entry.options,
          pageRatio:    entry.pageRatio,
        };
      }),
    };
    return snapshot;
  }

  // ══════════════════════════════════════════════════════════
  // 7. CROSS-TAB PLAYBACK HELPER
  //    When playing across multiple tabs, fields may have
  //    slightly different labels or structure. This wrapper
  //    tries 3 strategies in sequence:
  //      A) Deep fingerprint resolution
  //      B) Exact label from page map
  //      C) Token-based fuzzy search
  // ══════════════════════════════════════════════════════════

  function findFieldForStep(step) {
    const fp = step.deepFingerprint || step.labelFingerprint || null;
    const label = step.label || '';

    // Strategy A: deep fingerprint
    if (fp) {
      const el = resolveByFingerprint(fp, label);
      if (el && isVisible(el)) {
        if (window.__smartbotDebug) console.log(`[MacroAnalyzer] A-fingerprint resolved "${label}"`);
        return el;
      }
    }

    // Strategy B: exact page map lookup
    ensurePageMap();
    const exactKey = normStr(label);
    if (_pageMap.has(exactKey)) {
      const entry = _pageMap.get(exactKey);
      if (entry && isVisible(entry.el)) {
        if (window.__smartbotDebug) console.log(`[MacroAnalyzer] B-exactmap resolved "${label}"`);
        return entry.el;
      }
    }

    // Strategy C: token-based fuzzy scan
    const queryTokens = tokenise(label);
    if (queryTokens.length > 0) {
      const candidates = collectAllFields();
      let best = null, bestScore = 0;
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const elLabels = extractAllLabels(el).map(c => c.text);
        for (const lbl of elLabels) {
          const elTok = tokenise(lbl);
          const hits = queryTokens.filter(t => elTok.some(et => norm(et) === norm(t))).length;
          const s = Math.round(200 * hits / Math.max(queryTokens.length, elTok.length, 1));
          if (s > bestScore) { bestScore = s; best = el; }
        }
      }
      if (best && bestScore >= 100) {
        if (window.__smartbotDebug) console.log(`[MacroAnalyzer] C-fuzzy resolved "${label}" score=${bestScore}`);
        return best;
      }
    }

    return null;
  }

  // ══════════════════════════════════════════════════════════
  // 8. PUBLIC API
  // ══════════════════════════════════════════════════════════

  return {
    // Core
    snapshotPage,
    buildDeepFingerprint,
    resolveByFingerprint,
    resolveDropdownOption,
    findFieldForStep,

    // Utilities
    extractAllLabels,
    extractContext,
    isVisible,
    normStr,
    tokenise,

    // Direct map access (for debugging / popup)
    getPageMap: () => { ensurePageMap(); return _pageMap; },
    forceRebuild: () => { _pageMapDirty = true; ensurePageMap(); },
  };

})();
