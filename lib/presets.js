// Role presets — one shared deliberation core, two intake/output shapes.
//
// A preset is pure config: it seeds which specialists get injected, swaps the
// landing example prompts, and selects the synthesis header set that the
// Decision Record renders from. It MUST NOT fork agent prompts, phase order,
// or escalation logic — if it ever needs to, the engineer/scientist split has
// metastasized and the preset should be deleted instead.
//
// PRE-COMMITMENT (Red Team): `escalation_tolerance` and any future
// `lead_agents_per_phase` are EXPERIMENTAL. If presets are behaviorally
// indistinguishable on these at n=20 sessions each, delete the fields — do not
// leave dead config. See docs/superpowers/specs/2026-05-27-*.md.
const EXPERIMENTAL_FIELDS = ['escalation_tolerance', 'lead_agents_per_phase'];

const PRESETS = {
  engineer: {
    id: 'engineer',
    label: 'Engineer',
    tagline: 'Architecture, trade-offs, ship decisions',
    specialists: ['engineering-infra', 'security', 'engineering-ml'],
    examples: [
      'Compare the trade-offs between microservices and a monolith for a 10-person startup.',
      'Design a system for real-time collaborative document editing with offline mode and conflict resolution.',
      'Evaluate whether to build or buy an authentication system, weighing security, cost, and maintenance.',
    ],
    output_template: 'decision_record',
    synthesis_headers: ['DECISION', 'RATIONALE', 'NEXT ACTIONS', 'RISKS'],
    escalation_tolerance: 'high', // experimental
  },
  scientist: {
    id: 'scientist',
    label: 'Scientist',
    tagline: 'Methods, statistical rigor, reproducibility',
    specialists: ['data-science', 'engineering-ml', 'research-methods'],
    examples: [
      'Is this experimental design statistically sound, and what would strengthen it?',
      'Reconcile these conflicting study findings and tell me what to trust.',
      'Choose and justify a model/analysis approach for this dataset and research question.',
    ],
    output_template: 'methods_report',
    synthesis_headers: ['CLAIM', 'METHODS', 'EVIDENCE/CITATIONS', 'LIMITATIONS'],
    escalation_tolerance: 'low', // experimental
  },
};

function listPresets() {
  return Object.values(PRESETS).map(p => ({
    id: p.id,
    label: p.label,
    tagline: p.tagline,
    examples: p.examples,
    specialists: p.specialists,
  }));
}

// Resolve a preset id to its full config. Unknown / falsy id → null (Generalist:
// no preset, the default). Never throws — a bad id is just "no preset".
function getPreset(id) {
  if (!id) return null;
  return PRESETS[id] || null;
}

module.exports = { PRESETS, listPresets, getPreset, EXPERIMENTAL_FIELDS };
