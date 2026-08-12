// The browser rendered `active ? 'Active' : 'Complete'`, so a run a redeploy
// killed at Problem Framing showed a green "done" dot and a Complete badge,
// indistinguishable from one that reached Synthesis. The badge is now derived
// from the outcome, and both the detail view and the history card read it from
// here so they cannot disagree.
import { describe, it, expect } from 'vitest';
import { sessionBadge } from '../../public/util.js';

describe('sessionBadge', () => {
  it('reports a running session as active', () => {
    expect(sessionBadge({ active: true, outcome: null })).toMatchObject({ label: 'Active', cls: 'active' });
  });

  it('reports a run that ended early as stopped, not complete', () => {
    const badge = sessionBadge({ active: false, outcome: 'stopped' });
    expect(badge.label).toBe('Stopped');
    expect(badge.cls).toBe('interrupted');
  });

  it('reports a run with no verdict as failed', () => {
    expect(sessionBadge({ active: false, outcome: 'failed' })).toMatchObject({ label: 'Failed', cls: 'interrupted' });
  });

  it('reports a restart casualty as interrupted', () => {
    expect(sessionBadge({ active: false, outcome: 'crashed' }).label).toBe('Interrupted');
    // crash_recovered_at without an outcome is the pre-existing signal.
    expect(sessionBadge({ active: false, outcome: null, crashRecovered: true }).label).toBe('Interrupted');
  });

  it('reports a finished run as complete', () => {
    expect(sessionBadge({ active: false, outcome: 'complete' })).toMatchObject({ label: 'Complete', cls: 'idle' });
  });

  it('treats a legacy row with no outcome as complete', () => {
    expect(sessionBadge({ active: false, outcome: null }).label).toBe('Complete');
  });

  it('survives a missing session object', () => {
    expect(sessionBadge(undefined).label).toBe('Complete');
  });
});
