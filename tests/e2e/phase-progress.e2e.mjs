/**
 * HLB-150: the right-panel Phase Progress (`#desktop-phases`, `dphase-*`), its
 * phase-bar twin (`#phase-bar`, `pbar-*`), and the mobile sheet (`phase-*`) must
 * advance through the five phases as the deliberation runs, and must reflect the
 * correct phase when an in-progress session is reopened.
 *
 * The defect this spec pins: `renderPhases()` / `renderPhaseBar()` rebuild the
 * phase nodes in their default "all pending" state and there is no persisted
 * active index to re-apply afterwards. The server re-broadcasts a `phases` event
 * on every WebSocket (re)connection (server.js connection handler), so each
 * reconnect during a long deliberation wipes the live indicator back to the
 * first phase, so the panel appears stuck for the whole session. The same gap
 * makes a reopen lose the phase when `session-state` is processed before the
 * `phases` event (the two arrive as independent fetches in HTTP-fallback mode).
 *
 * Driven end-to-end against a live server with an isolated temp DB (spawnServer).
 * Phase transitions are delivered through the genuine `handleMessage` path; no
 * LLM calls. The active/completed state is read straight off the rendered DOM.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR =
  (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'orchestrate', 'HLB-150')) ||
  '/tmp/orchestrate/HLB-150';
mkdirSync(ARTIFACT_DIR, { recursive: true });

const FIVE = [
  { name: 'Problem Framing' },
  { name: 'Divergence' },
  { name: 'Convergence' },
  { name: 'Red Team' },
  { name: 'Synthesis' },
];

// One label per index, derived from the className, for whichever id-prefix is
// asked for: '' (mobile sheet), 'd' (desktop right panel), or the bar (pbar-).
async function readPhaseState(page) {
  return page.evaluate(() => {
    const label = (id, base) => {
      const e = document.getElementById(id);
      if (!e) return 'MISSING';
      const cls = e.className.replace(base, '').trim();
      return cls || 'pending';
    };
    const idx = [0, 1, 2, 3, 4];
    return {
      mobile: idx.map((i) => label('phase-' + i, 'sheet-phase')),
      desktop: idx.map((i) => label('dphase-' + i, 'sheet-phase')),
      bar: idx.map((i) => label('pbar-' + i, 'pb-item')),
    };
  });
}

// Expected pattern for an active phase at index `active`: everything before is
// completed, the active one is active, everything after is pending.
function expectedAt(active, total = 5) {
  return Array.from({ length: total }, (_, i) =>
    i < active ? 'completed' : i === active ? 'active' : 'pending',
  );
}
// All phases done (completed session restore).
function allCompleted(total = 5) {
  return Array.from({ length: total }, () => 'completed');
}

function seedSession(dbPath, sessionId, phase, active) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, 'HLB-150 e2e: phase progress', phase, active ? 1 : 0, now, now);
    db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), sessionId, 'process-architect', 'Process Architect', '🤖', '#00ff41', 'A seeded transcript line with real body.', 'Problem Framing', now);
  } finally {
    db.close();
  }
}

async function bootPage(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof handleMessage === 'function' && typeof phases !== 'undefined', null, { timeout: 8000 });
}

test.describe('HLB-150 phase progress advances and survives reopen', () => {
  let server;

  test.beforeAll(async () => {
    server = await spawnServer();
  });

  test.afterAll(async () => {
    if (server) await server.dispose();
  });

  test('advances through all five phases live, and survives a phases re-broadcast', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.setViewportSize({ width: 1280, height: 900 });
    await bootPage(page, server.baseUrl);

    // Phases land (server pushes this on connect).
    await page.evaluate((five) => handleMessage({ type: 'phases', phases: five }), FIVE);
    await page.waitForTimeout(50);

    // Drive every phase-change and assert all three surfaces advance together.
    for (let active = 0; active < 5; active++) {
      await page.evaluate((idx) => handleMessage({ type: 'phase-change', phase: idx, phaseName: 'P' + idx, sessionId: 'live' }), active);
      await page.waitForTimeout(40);
      const state = await readPhaseState(page);
      const exp = expectedAt(active);
      expect(state.desktop, `#desktop-phases at phase ${active}`).toEqual(exp);
      expect(state.bar, `#phase-bar at phase ${active}`).toEqual(exp);
      expect(state.mobile, `mobile sheet at phase ${active}`).toEqual(exp);
    }

    // THE BUG: the server re-broadcasts `phases` on every (re)connection. Before
    // the fix this rebuilds the phase nodes to all-pending and the live indicator
    // is lost (the panel reverts to the first phase mid-session). After the fix
    // the active phase (4) survives the rebuild.
    await page.evaluate((five) => handleMessage({ type: 'phases', phases: five }), FIVE);
    await page.waitForTimeout(50);
    const afterRebroadcast = await readPhaseState(page);
    expect(afterRebroadcast.desktop, '#desktop-phases must survive a phases re-broadcast').toEqual(expectedAt(4));
    expect(afterRebroadcast.bar, '#phase-bar must survive a phases re-broadcast').toEqual(expectedAt(4));
    expect(afterRebroadcast.mobile, 'mobile sheet must survive a phases re-broadcast').toEqual(expectedAt(4));

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('reopening an active session at phase 3 shows phase 3 even when session-state precedes the phases event', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await bootPage(page, server.baseUrl);

    // Reproduce the HTTP-fallback ordering: /api/sessions/:id (session-state)
    // resolves BEFORE /api/phases. Reset to the pre-phases state, deliver
    // session-state first, then the phases event.
    await page.evaluate((five) => {
      phases = [];
      document.getElementById('desktop-phases').innerHTML = '';
      document.getElementById('phase-bar').innerHTML = '';
      document.getElementById('sheet-phase-list').innerHTML = '';
      handleMessage({ type: 'session-state', session: {
        id: 'reopen-active', problem: 'reopen at phase 3', phase: 3, active: true,
        messages: [], escalations: [], humanMessages: [],
      }});
      handleMessage({ type: 'phases', phases: five });
    }, FIVE);
    await page.waitForTimeout(80);

    const state = await readPhaseState(page);
    expect(state.desktop, '#desktop-phases on reopen at phase 3').toEqual(expectedAt(3));
    expect(state.bar, '#phase-bar on reopen at phase 3').toEqual(expectedAt(3));
    expect(state.mobile, 'mobile sheet on reopen at phase 3').toEqual(expectedAt(3));
  });

  test('reopening a completed session shows every phase completed (1280px and 768px)', async ({ page }) => {
    const sessionId = randomUUID();
    seedSession(server.dbPath, sessionId, 4, false); // inactive => completed restore

    // 1280px desktop: right panel visible.
    await page.setViewportSize({ width: 1280, height: 900 });
    await bootPage(page, server.baseUrl);
    await page.evaluate((s) => { ws.send(JSON.stringify({ type: 'join-session', sessionId: s })); }, sessionId);
    await expect(page.locator('#feed .message')).toHaveCount(1, { timeout: 8000 });
    await page.evaluate((five) => handleMessage({ type: 'phases', phases: five }), FIVE); // reconnect re-broadcast
    await page.waitForTimeout(80);

    let state = await readPhaseState(page);
    expect(state.desktop, '#desktop-phases on completed reopen (1280)').toEqual(allCompleted());
    expect(state.bar, '#phase-bar on completed reopen (1280)').toEqual(allCompleted());
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'completed-1280.png'), fullPage: false });

    // 768px tablet: panel still renders.
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(120);
    state = await readPhaseState(page);
    expect(state.desktop, '#desktop-phases on completed reopen (768)').toEqual(allCompleted());
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'completed-768.png'), fullPage: false });
  });
});
