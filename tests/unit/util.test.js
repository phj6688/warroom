// @vitest-environment happy-dom
// HLB-895 - first vitest unit coverage for the leaf helpers extracted into
// public/util.js. CJS require + vitest globals to match the repo's .test.js
// convention (globals: true in vitest.config.js). happy-dom gives escHtml a
// document at call time without a real browser.
const { escHtml, formatFileSize, fmtSize, parseSynthesisSections, mdToText } = require('../../public/util.js');

describe('escHtml', () => {
  test('renders an img/onerror payload as inert text (no live tag)', () => {
    const out = escHtml('<img src=x onerror="window.__x=1">');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
  test('escapes angle brackets and ampersands', () => {
    const out = escHtml('a < b & c');
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).not.toContain('< b');
  });
});

describe('byte-size formatters', () => {
  test('formatFileSize uses spaced units', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024 * 2)).toBe('2.0 MB');
  });
  test('fmtSize uses unspaced units and stays distinct from formatFileSize', () => {
    expect(fmtSize(512)).toBe('512B');
    expect(fmtSize(1536)).toBe('1.5KB');
    expect(fmtSize(512)).not.toBe(formatFileSize(512));
  });
});

describe('parseSynthesisSections', () => {
  test('empty input yields an empty array', () => {
    expect(parseSynthesisSections('')).toEqual([]);
  });
  test('no ## heading yields a single SUMMARY block', () => {
    expect(parseSynthesisSections('just some body')).toEqual([
      { label: 'SUMMARY', body: 'just some body' },
    ]);
  });
  test('splits on ## headings into label/body pairs', () => {
    const r = parseSynthesisSections('## First\nalpha\n## Second\nbeta');
    expect(r.map((x) => x.label)).toEqual(['First', 'Second']);
    expect(r[0].body).toBe('alpha');
    expect(r[1].body).toBe('beta');
  });
});

describe('mdToText', () => {
  test('strips bold, italic, code, headings and bullets', () => {
    expect(mdToText('**bold** *it* `code`')).toBe('bold it code');
    expect(mdToText('# Heading')).toBe('Heading');
    expect(mdToText('- item')).toBe('• item');
  });
  test('is null-safe', () => {
    expect(mdToText(null)).toBe('');
  });
});
