// ============================================================
// SmartBot LabelScanner — v9.0
// ✦ Now powered by SmartMacroAnalyzer (full-page deep scan)
// ✦ buildFieldFingerprint → deep 15-signal fingerprint
// ✦ resolveFieldByFingerprint → 12-strategy scorer
// ✦ All v8 public API methods preserved (drop-in upgrade)
// ============================================================

window.SmartLabelScanner = (function () {

  function normLabel(s) {
    return window.SmartMacroAnalyzer
      ? window.SmartMacroAnalyzer.normStr(s)
      : String(s || '').toLowerCase().replace(/[*:\s]+/g, ' ').trim();
  }

  function tokenise(s) {
    return window.SmartMacroAnalyzer
      ? window.SmartMacroAnalyzer.tokenise(s)
      : normLabel(s).split(/\s+/).filter(t => t.length > 1);
  }

  function buildFieldFingerprint(el) {
    if (window.SmartMacroAnalyzer) {
      return window.SmartMacroAnalyzer.buildDeepFingerprint(el);
    }
    const rect = el.getBoundingClientRect();
    return {
      primaryLabel: el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '',
      allLabels: [],
      labelNorm: normLabel(el.getAttribute('aria-label') || el.name || ''),
      labelTokens: tokenise(el.getAttribute('aria-label') || el.name || ''),
      id: el.id || null, name: el.name || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      dataTestId: el.getAttribute('data-testid') || null,
      placeholder: el.placeholder || null,
      tagName: el.tagName.toLowerCase(), inputType: el.type || null,
      formId: el.form?.id || null,
      pagePositionRatio: parseFloat(((rect.top + window.scrollY) / Math.max(document.body.scrollHeight, 1)).toFixed(4)),
    };
  }

  function scanPage() {
    if (!window.SmartMacroAnalyzer) return [];
    const snapshot = window.SmartMacroAnalyzer.snapshotPage();
    const fields = Array.from(document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),' +
      'select,textarea,[role="combobox"],[role="listbox"],[role="switch"],[role="spinbutton"],' +
      '[role="textbox"],[role="searchbox"],[role="slider"],[contenteditable="true"]'
    ));
    return snapshot.fields.map(f => ({
      index: f.index, label: f.primaryLabel, allLabels: f.allLabels,
      fingerprint: fields[f.index] ? buildFieldFingerprint(fields[f.index]) : null,
      el: fields[f.index] || null,
    })).filter(f => f.el);
  }

  function resolveFieldByFingerprint(fingerprint, fallbackLabel) {
    return window.SmartMacroAnalyzer
      ? window.SmartMacroAnalyzer.resolveByFingerprint(fingerprint, fallbackLabel)
      : null;
  }

  function resolveStep(step) {
    return window.SmartMacroAnalyzer
      ? window.SmartMacroAnalyzer.findFieldForStep(step)
      : resolveFieldByFingerprint(step.deepFingerprint || step.labelFingerprint, step.label);
  }

  function extractLabels(el) {
    if (window.SmartMacroAnalyzer) {
      const candidates = window.SmartMacroAnalyzer.extractAllLabels(el);
      return { primary: candidates[0]?.text || el.name || el.id || el.tagName.toLowerCase(), candidates: candidates.map(c => c.text) };
    }
    return { primary: el.name || el.id || '', candidates: [] };
  }

  return { scanPage, buildFieldFingerprint, extractLabels, resolveFieldByFingerprint, resolveStep, normLabel, tokenise };
})();
