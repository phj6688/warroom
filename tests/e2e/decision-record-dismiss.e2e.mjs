/**
 * HLB-140 — the sticky `.decision-record` ("The Answer") card must carry a
 * dismiss control so the user can read the full transcript again.
 *
 * This drives the REAL path end-to-end against a live server (isolated temp DB
 * via spawnServer): a completed session carrying a Synthesis message is seeded
 * straight into the server's SQLite file (the same rows a finished deliberation
 * persists — see server.js insertMessage / updateSessionActive), then the page
 * loads it over the genuine `join-session` → `session-state` WebSocket path. The
 * server's handler mounts the card itself; the test fakes no DOM and installs no
 * page-side test hook, so production index.html ships no debug residue.
 *
 * It asserts the dismiss control's existence, accessibility, placement,
 * behaviour, and idempotence under a re-render, confirms the pre-existing
 * Copy / Export / Copy-as-prompt and quality-rating wiring survives the change,
 * and that dismissing fires no console errors.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Artifact dir: prefer the orchestrator job dir, else a temp dir.
const ARTIFACT_DIR =
  (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'orchestrate', 'HLB-140')) ||
  path.join(os.tmpdir(), 'hlb-140-artifacts');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const SYNTH = `## DECISION
Adopt the typed renderer for the decision record card.

## RATIONALE
It removes the per-poll innerHTML churn that caused flicker and keeps the
sticky answer card stable while the transcript continues to stream beneath it.

## NEXT STEPS
- Ship the dismiss control so the transcript is readable again.
- Verify the quality one-tap still posts.`;

// Seed a completed deliberation straight into the server's DB file (the seam the
// server already exposes to tests via WAR_ROOM_DB_PATH): an inactive session row,
// a tall agent transcript, and the process-architect Synthesis message the
// Decision Record templates from — the same rows server.js persists on a real
// run. Seeding the row directly (rather than POST /api/sessions) keeps it out of
// the server's in-memory activeSessions map, so the WS join-session handler falls
// through to loadSession() and replies with the genuine completed session-state.
function seedCompletedSession(dbPath, sessionId, problem) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(sessionId, problem, 6, now, now);
    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    // A tall transcript so the sticky card visibly overlays prior messages and
    // the feed is scrollable (the R4 no-jump check needs real scroll room).
    for (let i = 0; i < 14; i++) {
      insertMsg.run(
        randomUUID(), sessionId, `agent-${i}`, `Agent ${i + 1}`, '🤖', '#00ff41',
        `Transcript message ${i + 1} — agents deliberating in the feed with enough body text to give the scroll container real height to work with.`,
        'Analysis', now + i,
      );
    }
    insertMsg.run(
      randomUUID(), sessionId, 'process-architect', 'Process Architect', '⚑', '#00ff41',
      SYNTH, 'Synthesis', now + 100,
    );
  } finally {
    db.close();
  }
}

test.describe('HLB-140 decision-record dismiss control', () => {
  let server;
  let sessionId;
  const consoleErrors = [];

  test.beforeAll(async () => {
    server = await spawnServer();
    // Seed a completed session (Synthesis + transcript) directly into the
    // server's DB so the card mounts via the genuine join-session flow. The
    // quality one-tap later POSTs to this real row (the route reads it from DB).
    sessionId = randomUUID();
    seedCompletedSession(server.dbPath, sessionId, 'HLB-140 e2e: decision record dismiss');
  });

  test.afterAll(async () => {
    if (server) await server.dispose();
  });

  test('completed-session card is dismissible and stays dismissed', async ({ page, context }) => {
    // Copy / Copy-as-prompt use navigator.clipboard.writeText.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    // Wait for the live WS to open, then load the completed session the same way
    // the UI does (session-card click → join-session). The server replies with
    // session-state and the page's own handler mounts the card — no test hook.
    // `ws` and `renderDecisionRecord` are script-scope globals (the page is a
    // classic script, not a module), reachable here by bare name.
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
    await page.evaluate((sid) => ws.send(JSON.stringify({ type: 'join-session', sessionId: sid })), sessionId);

    const card = page.locator('#decision-record');
    await expect(card).toBeVisible({ timeout: 8000 });

    // BEFORE: the sticky answer card pinned over the transcript.
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'before-card-pinned.png'), fullPage: false });

    // AC1 / R1+R3: a visible dismiss control with the right aria-label.
    const dismiss = card.getByRole('button', { name: 'Dismiss' });
    await expect(dismiss).toBeVisible();
    await expect(dismiss).toHaveAttribute('aria-label', 'Dismiss');

    // >= 44px touch target.
    const box = await dismiss.boundingBox();
    expect(box, 'dismiss control must have a layout box').not.toBeNull();
    expect(box.width, `width ${box?.width} should be >= 44`).toBeGreaterThanOrEqual(44);
    expect(box.height, `height ${box?.height} should be >= 44`).toBeGreaterThanOrEqual(44);

    // Top-right placement: control's right edge near the card's right edge,
    // and it must not overlap the title horizontally.
    const cardBox = await card.boundingBox();
    expect(cardBox.x + cardBox.width - (box.x + box.width)).toBeLessThan(40);
    const titleBox = await card.locator('.dr-title').boundingBox();
    expect(box.x, 'dismiss control should sit to the right of the title').toBeGreaterThan(titleBox.x);

    // Keyboard reachable: it must be a focusable element.
    await dismiss.focus();
    await expect(dismiss).toBeFocused();

    // AC3: the pre-existing action buttons are still present and wired.
    await expect(card.locator('[data-act="copy"]')).toBeVisible();
    await expect(card.locator('[data-act="export"]')).toBeVisible();
    await expect(card.locator('[data-act="prompt"]')).toBeVisible();
    await expect(card.locator('.dr-q[data-q="USEFUL"]')).toBeVisible();

    // Copy writes the synthesis to the clipboard.
    await card.locator('[data-act="copy"]').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('Adopt the typed renderer');

    // Copy-as-prompt wraps the synthesis in a context prompt.
    await card.locator('[data-act="prompt"]').click();
    const clipPrompt = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipPrompt).toContain('8-agent War Room deliberation');
    expect(clipPrompt).toContain('Adopt the typed renderer');

    // Export .md triggers a markdown file download.
    const downloadP = page.waitForEvent('download', { timeout: 4000 });
    await card.locator('[data-act="export"]').click();
    const download = await downloadP;
    expect(download.suggestedFilename()).toMatch(/^decision-record-.*\.md$/);

    // The quality one-tap still POSTs to /api/sessions/:id/quality and the
    // server accepts it (200). Proves AC3's rating path end-to-end.
    const qualityRespP = page.waitForResponse(
      (r) => r.url().includes(`/api/sessions/${sessionId}/quality`) && r.request().method() === 'POST',
      { timeout: 5000 },
    );
    await card.locator('.dr-q[data-q="USEFUL"]').click();
    const qualityResp = await qualityRespP;
    expect(qualityResp.status()).toBe(200);
    expect(JSON.parse(qualityResp.request().postData() || '{}').rating).toBe('USEFUL');
    // Observable handler effect: the tapped option locks in.
    await expect(card.locator('.dr-q[data-q="USEFUL"]')).toHaveClass(/sel/);

    // R4 is only meaningful if the feed is actually scrolled past the card:
    // scroll it down, then confirm the transcript rows keep their on-screen
    // position when the (first-child, flow-occupying) card is removed.
    const scrollBefore = await page.evaluate(() => {
      const f = document.getElementById('feed');
      f.style.scrollBehavior = 'auto'; // smooth-scroll makes programmatic set async
      f.scrollTop = Math.max(0, Math.round(f.scrollHeight / 3));
      return f.scrollTop;
    });
    expect(scrollBefore, 'feed should be scrollable so the R4 check is real').toBeGreaterThan(0);
    // Anchor on a real transcript row's viewport position before dismissal.
    const anchor = page.locator('#feed .message').nth(6);
    const yBefore = (await anchor.boundingBox()).y;

    // AC2: clicking the control removes/collapses the card.
    await dismiss.click();
    await expect(page.locator('#decision-record')).toHaveCount(0);

    // R4: the same transcript row stays visually put (no jump) after removal.
    const yAfter = (await anchor.boundingBox()).y;
    expect(Math.abs(yAfter - yBefore), `row jumped ${yBefore} -> ${yAfter}`).toBeLessThanOrEqual(2);

    // AFTER: the full transcript is visible with no sticky overlay.
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-dismissed.png'), fullPage: false });

    // AC2: a subsequent poll / re-render must NOT force the card back.
    await page.evaluate(() => renderDecisionRecord());
    await expect(page.locator('#decision-record')).toHaveCount(0);

    // AC3: no console errors fired through the whole flow.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
