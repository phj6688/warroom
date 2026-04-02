const PHASES = [
  { id: 'framing', name: 'Problem Framing', agents: ['process-architect', 'research-scout', 'systems-synthesizer'] },
  { id: 'divergence', name: 'Divergence', agents: ['divergent-generator', 'systems-synthesizer', 'quantitative-expert', 'qualitative-expert'] },
  { id: 'convergence', name: 'Convergence', agents: ['convergent-evaluator', 'quantitative-expert', 'qualitative-expert', 'research-scout'] },
  { id: 'red-team', name: 'Red Team', agents: ['red-teamer', 'convergent-evaluator', 'process-architect'] },
  { id: 'synthesis', name: 'Synthesis', agents: ['process-architect'] },
];

module.exports = { PHASES };
