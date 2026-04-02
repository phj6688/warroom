const fs = require('fs');
const path = require('path');

const promptsDir = path.join(__dirname, '..', 'prompts', 'core');

function loadPrompt(agentId) {
  const file = path.join(promptsDir, `${agentId}.md`);
  return fs.readFileSync(file, 'utf-8').trim();
}

const AGENTS = [
  {
    id: 'process-architect', name: 'Process Architect', emoji: '🎯', color: '#00ff41',
    role: 'Metacognitive Conductor', hat: 'Blue Hat',
    systemPrompt: loadPrompt('process-architect'),
  },
  {
    id: 'systems-synthesizer', name: 'Systems Synthesizer', emoji: '🔗', color: '#00e639',
    role: 'Boundary Spanner', hat: 'Cross-Domain',
    systemPrompt: loadPrompt('systems-synthesizer'),
  },
  {
    id: 'divergent-generator', name: 'Divergent Generator', emoji: '💡', color: '#00cc30',
    role: 'Creative Disruptor', hat: 'Green Hat',
    systemPrompt: loadPrompt('divergent-generator'),
  },
  {
    id: 'convergent-evaluator', name: 'Convergent Evaluator', emoji: '⚖️', color: '#00b328',
    role: 'Analytical Engine', hat: 'Black/White Hat',
    systemPrompt: loadPrompt('convergent-evaluator'),
  },
  {
    id: 'red-teamer', name: 'Red Teamer', emoji: '🔴', color: '#00991f',
    role: 'Adversarial Stress-Tester', hat: "Devil's Advocate",
    systemPrompt: loadPrompt('red-teamer'),
  },
  {
    id: 'quantitative-expert', name: 'Quantitative Expert', emoji: '📐', color: '#008017',
    role: 'Technical Depth', hat: 'STEM',
    systemPrompt: loadPrompt('quantitative-expert'),
  },
  {
    id: 'qualitative-expert', name: 'Qualitative Expert', emoji: '📜', color: '#00660f',
    role: 'Institutional Depth', hat: 'Policy/Business',
    systemPrompt: loadPrompt('qualitative-expert'),
  },
  {
    id: 'research-scout', name: 'Research Scout', emoji: '🔍', color: '#00ff41',
    role: 'Information Architect', hat: 'Intel',
    systemPrompt: loadPrompt('research-scout'),
  },
];

module.exports = { AGENTS };
