/*
 * war-room leaf helpers (HLB-895). Sanitize/render utilities extracted verbatim
 * from public/index.html so they gain unit coverage.
 *
 * Dual-mode, no behavior change:
 *   Browser: loaded as a classic <script src="/util.js"> in <head>, so each
 *   helper is a window global before the main inline script runs and the
 *   existing call sites resolve unchanged.
 *   Node/vitest: module.exports the same functions for unit tests.
 *
 * formatFileSize (spaced units) and fmtSize (no space) stay deliberately
 * distinct: they render in different places and produce different strings.
 */
(function (global) {
  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  }

  function parseSynthesisSections(text) {
    if (!text) return [];
    const re = /^##\s+(.+?)\s*$/gm;
    const idx = []; let m;
    while ((m = re.exec(text)) !== null) idx.push({ label: m[1].trim(), contentStart: re.lastIndex, start: m.index });
    if (idx.length === 0) return [{ label: 'SUMMARY', body: text.trim() }];
    return idx.map((it, i) => ({
      label: it.label,
      body: text.slice(it.contentStart, i + 1 < idx.length ? idx[i + 1].start : text.length).trim(),
    }));
  }

  function mdToText(s) {
    return (s || '')
      .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1').replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ').trim();
  }

  // One answer to "how did this session end", shared by the detail badge and
  // the history card. `active` alone cannot answer it: an inactive session is
  // only complete when its outcome says so, and rendering every inactive row
  // as Complete is what let a run killed at Problem Framing look finished.
  // A null outcome is a legacy row from before the column existed.
  const SESSION_BADGES = {
    complete: { label: 'Complete', cls: 'idle', title: 'Deliberation finished — export results or ask follow-ups' },
    stopped: { label: 'Stopped', cls: 'interrupted', title: 'Ended before the last phase — resume to run the rest' },
    failed: { label: 'Failed', cls: 'interrupted', title: 'No verdict produced — the agent turns did not get through' },
    crashed: { label: 'Interrupted', cls: 'interrupted', title: 'A server restart ended this run — resume to continue' },
  };
  function sessionBadge(session) {
    const s = session || {};
    if (s.active) return { label: 'Active', cls: 'active', title: 'Agents are processing' };
    if (s.outcome && SESSION_BADGES[s.outcome]) return SESSION_BADGES[s.outcome];
    if (s.crashRecovered) return SESSION_BADGES.crashed;
    return SESSION_BADGES.complete;
  }

  const api = { escHtml, formatFileSize, fmtSize, parseSynthesisSections, mdToText, sessionBadge, SESSION_BADGES };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    for (const k in api) global[k] = api[k];
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
