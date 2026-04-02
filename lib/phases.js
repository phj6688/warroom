// Default v3 linear phase definitions
const DEFAULT_PHASES = [
  { id: 'framing', name: 'Problem Framing', agents: ['process-architect', 'research-scout', 'systems-synthesizer'] },
  { id: 'divergence', name: 'Divergence', agents: ['divergent-generator', 'systems-synthesizer', 'quantitative-expert', 'qualitative-expert'] },
  { id: 'convergence', name: 'Convergence', agents: ['convergent-evaluator', 'quantitative-expert', 'qualitative-expert', 'research-scout'] },
  { id: 'red-team', name: 'Red Team', agents: ['red-teamer', 'convergent-evaluator', 'process-architect'] },
  { id: 'synthesis', name: 'Synthesis', agents: ['process-architect'] },
];

const MAX_LOOPBACKS = 3;

/**
 * PhaseRouter — state machine for phase transitions.
 * Default config produces identical v3 linear behavior.
 */
function createRouter(config) {
  const phases = (config && config.phases) || DEFAULT_PHASES;
  let currentIdx = 0;
  let loopbackCount = 0;
  const history = []; // [{from, to, reason, timestamp}]

  return {
    /** Get current phase object */
    current() {
      return { ...phases[currentIdx], index: currentIdx };
    },

    /** Get all phases */
    phases() {
      return phases;
    },

    /** Total phase count */
    length() {
      return phases.length;
    },

    /** Check if session has produced enough output to advance */
    canAdvance(session) {
      const phase = phases[currentIdx];
      // Exit criteria: all agents in this phase have produced at least one message
      const phaseMessages = session.messages.filter(m => m.phase === phase.name);
      const agentsCovered = new Set(phaseMessages.map(m => m.agentId));
      return phase.agents.every(a => agentsCovered.has(a));
    },

    /** Advance to next phase. Returns next phase or null if done. */
    next(session, reason) {
      const from = currentIdx;

      if (currentIdx >= phases.length - 1) {
        history.push({ from, to: null, reason: reason || 'deliberation complete', timestamp: Date.now() });
        return null; // Deliberation complete
      }

      currentIdx++;
      const to = currentIdx;
      history.push({ from, to, reason: reason || `advance to ${phases[to].name}`, timestamp: Date.now() });
      console.log(`[phases] ${phases[from].name} → ${phases[to].name} (${reason || 'linear advance'})`);

      return this.current();
    },

    /** Check if loop-back is allowed */
    canLoop() {
      return loopbackCount < MAX_LOOPBACKS;
    },

    /** Loop back to a previous phase (e.g., Red Team triggers re-framing) */
    loopTo(targetIdx, reason) {
      if (loopbackCount >= MAX_LOOPBACKS) {
        console.warn(`[phases] Loop-back denied: max ${MAX_LOOPBACKS} reached`);
        return false;
      }
      if (targetIdx < 0 || targetIdx >= phases.length) return false;

      const from = currentIdx;
      loopbackCount++;
      currentIdx = targetIdx;
      history.push({
        from, to: targetIdx,
        reason: reason || `loop-back to ${phases[targetIdx].name}`,
        timestamp: Date.now(), loopback: true,
      });
      console.log(`[phases] LOOP-BACK: ${phases[from].name} → ${phases[targetIdx].name} (${loopbackCount}/${MAX_LOOPBACKS}) — ${reason}`);

      return true;
    },

    /** Get phase transition history */
    history() {
      return [...history];
    },

    /** Get current index */
    index() {
      return currentIdx;
    },

    /** Set index directly (for loading saved state) */
    setIndex(idx) {
      if (idx >= 0 && idx < phases.length) currentIdx = idx;
    },

    /** Check if deliberation is done */
    isDone() {
      return currentIdx >= phases.length - 1 && this.canAdvance({ messages: [] }) === false;
    },

    /** Serialize state for persistence */
    toJSON() {
      return { currentIdx, loopbackCount, history, phases };
    },
  };
}

// Backward-compatible export: PHASES array + createRouter
const PHASES = DEFAULT_PHASES;

module.exports = { PHASES, createRouter, DEFAULT_PHASES, MAX_LOOPBACKS };
