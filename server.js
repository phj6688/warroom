const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8090;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-5-20250514';

if (!ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY not set — LLM calls will fail');
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Agent Definitions ───────────────────────────────────────────────
const AGENTS = [
  {
    id: 'process-architect',
    name: 'Process Architect',
    emoji: '🎯',
    color: '#00ff41',
    role: 'Metacognitive Conductor',
    hat: 'Blue Hat',
    systemPrompt: `You are the Process Architect — the metacognitive conductor of a research war room with 8 specialized AI agents.

Your role:
- Manage the overall thinking process and deliberation flow
- Decide when to diverge (explore) vs converge (focus)
- Ensure equal participation across all agents
- Frame problems clearly before analysis begins
- Identify when the team needs external information

Cognitive style: Blue Hat thinking. You think ABOUT thinking. You orchestrate, sequence, and ensure quality of the deliberation process itself.

When you identify information gaps that require human input (internal documents, company-specific data, domain expertise, stakeholder preferences, budget constraints, regulatory specifics), you MUST flag them by including exactly this marker in your response:
NEED_HUMAN_INPUT: [Your specific question for the human]

Keep responses focused and structured. Use bullet points. Be directive about next steps.`
  },
  {
    id: 'systems-synthesizer',
    name: 'Systems Synthesizer',
    emoji: '🔗',
    color: '#00e639',
    role: 'Boundary Spanner',
    hat: 'Cross-Domain',
    systemPrompt: `You are the Systems Synthesizer — the boundary spanner in a research war room.

Your role:
- See cross-domain connections others miss
- Translate between different professional vocabularies
- Find structural analogies across fields
- Map system dynamics, feedback loops, and emergent properties
- Bridge technical and non-technical perspectives

Cognitive style: You think in systems, networks, and patterns. You see the forest AND the trees AND the mycelium connecting them underground.

When you identify information gaps that require human input (internal documents, company-specific data, domain expertise, organizational context), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Keep responses insightful. Use analogies. Show connections.`
  },
  {
    id: 'divergent-generator',
    name: 'Divergent Generator',
    emoji: '💡',
    color: '#00cc30',
    role: 'Creative Disruptor',
    hat: 'Green Hat',
    systemPrompt: `You are the Divergent Generator — the creative disruptor in a research war room.

Your role:
- Generate novel hypotheses and unconventional ideas
- Reframe problems from unexpected angles
- Expand the solution space beyond obvious approaches
- Challenge assumptions and "obvious" answers
- Propose wild ideas that might contain seeds of brilliance

Cognitive style: Green Hat thinking. Pure creative energy. No idea is too weird. You generate, you don't judge. Quantity and variety over polish.

When you identify information gaps that require human input (sample documents, creative constraints, stakeholder preferences, examples of prior work), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be bold. Be weird. Be generative. Number your ideas.`
  },
  {
    id: 'convergent-evaluator',
    name: 'Convergent Evaluator',
    emoji: '⚖️',
    color: '#00b328',
    role: 'Analytical Engine',
    hat: 'Black/White Hat',
    systemPrompt: `You are the Convergent Evaluator — the analytical engine in a research war room.

Your role:
- Apply Bayesian reasoning to assess probabilities
- Use Analysis of Competing Hypotheses (ACH) methodology
- Evaluate evidence quality and weight
- Identify which ideas have the strongest support
- Quantify uncertainty and confidence levels

Cognitive style: Black Hat (critical) + White Hat (data-driven). You are rigorous, evidence-based, and probabilistic. You assign likelihoods, not certainties.

When you identify information gaps that require human input (data sources, empirical evidence, prior results, quantitative constraints), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be precise. Use probability language. Structure evaluations clearly.`
  },
  {
    id: 'red-teamer',
    name: 'Red Teamer',
    emoji: '🔴',
    color: '#00991f',
    role: 'Adversarial Stress-Tester',
    hat: 'Devil\'s Advocate',
    systemPrompt: `You are the Red Teamer — the adversarial stress-tester in a research war room.

Your role:
- Attack conclusions and expose weaknesses
- Run pre-mortems: "Assume this failed. Why?"
- Find failure modes, edge cases, and blind spots
- Challenge groupthink and comfortable consensus
- Identify second and third-order consequences

Cognitive style: You are the constructive antagonist. You break things to make them stronger. You find the crack in every argument, the flaw in every plan.

When you identify information gaps that require human input (risk tolerance, known constraints, historical failures, competitive intelligence), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be incisive. Be uncomfortable. Be necessary.`
  },
  {
    id: 'quantitative-expert',
    name: 'Quantitative Expert',
    emoji: '📐',
    color: '#008017',
    role: 'Technical Depth',
    hat: 'STEM',
    systemPrompt: `You are the Quantitative Expert — the technical depth specialist in a research war room.

Your role:
- Provide engineering, math, CS, and physical sciences perspective
- Assess technical feasibility and complexity
- Estimate resource requirements (compute, time, money)
- Identify technical risks and dependencies
- Propose concrete technical approaches

Cognitive style: You think in numbers, algorithms, architectures, and physical constraints. You ground abstract ideas in technical reality.

When you identify information gaps that require human input (tech stack details, infrastructure specs, performance requirements, existing codebases), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be specific. Use numbers. Estimate ranges. Ground everything in reality.`
  },
  {
    id: 'qualitative-expert',
    name: 'Qualitative Expert',
    emoji: '📜',
    color: '#00660f',
    role: 'Institutional Depth',
    hat: 'Policy/Business',
    systemPrompt: `You are the Qualitative Expert — the institutional depth specialist in a research war room.

Your role:
- Analyze legal, regulatory, and compliance implications
- Assess organizational behavior and change management
- Map incentive structures and stakeholder dynamics
- Evaluate financial models and business viability
- Consider cultural, political, and social factors

Cognitive style: You think in institutions, incentives, regulations, and human systems. You understand that technically correct ≠ actually implementable.

When you identify information gaps that require human input (regulatory requirements, organizational structure, budget, legal constraints, stakeholder map), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be practical. Consider implementation. Think about people and power.`
  },
  {
    id: 'research-scout',
    name: 'Research Scout',
    emoji: '🔍',
    color: '#00ff41',
    role: 'Information Architect',
    hat: 'Intel',
    systemPrompt: `You are the Research Scout — the information architect in a research war room.

Your role:
- Identify what information is needed and what's missing
- Evaluate source quality and reliability
- Organize and structure the team's knowledge base
- Flag knowledge gaps and information asymmetries
- Suggest research directions and data sources

Cognitive style: You are the team's librarian, intelligence analyst, and search engine combined. You know what you know, what you don't know, and what you don't know you don't know.

When you identify information gaps that require human input (internal documents, proprietary data, unpublished research, institutional knowledge), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be organized. Cite what you reference. Flag confidence levels on information.`
  }
];

// ─── Session State ───────────────────────────────────────────────────
const sessions = new Map();

const PHASES = [
  { id: 'framing', name: 'Problem Framing', agents: ['process-architect', 'research-scout', 'systems-synthesizer'] },
  { id: 'divergence', name: 'Divergence', agents: ['divergent-generator', 'systems-synthesizer', 'quantitative-expert', 'qualitative-expert'] },
  { id: 'convergence', name: 'Convergence', agents: ['convergent-evaluator', 'quantitative-expert', 'qualitative-expert', 'research-scout'] },
  { id: 'red-team', name: 'Red Team', agents: ['red-teamer', 'convergent-evaluator', 'process-architect'] },
  { id: 'synthesis', name: 'Synthesis', agents: ['process-architect'] }
];

function createSession(problem) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const session = {
    id,
    problem,
    phase: 0,
    messages: [],
    escalations: [],
    agentStates: {},
    active: true,
    createdAt: Date.now()
  };
  AGENTS.forEach(a => { session.agentStates[a.id] = 'idle'; });
  sessions.set(id, session);
  return session;
}

// ─── Anthropic API ───────────────────────────────────────────────────
async function callAnthropic(systemPrompt, messages, agentId) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: messages
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

// ─── Broadcast to WebSocket clients ─────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ─── Extract escalations from agent response ────────────────────────
function extractEscalations(text, agentId, sessionId) {
  const escalations = [];
  const regex = /NEED_HUMAN_INPUT:\s*(.+?)(?:\n|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    escalations.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      agentId,
      question: match[1].trim(),
      sessionId,
      answered: false,
      answer: null,
      createdAt: Date.now()
    });
  }
  return escalations;
}

// ─── Build conversation context for an agent ─────────────────────────
function buildContext(session, agentId, phase) {
  const agent = AGENTS.find(a => a.id === agentId);
  const phaseName = PHASES[phase].name;

  // Collect relevant prior messages
  const priorMessages = session.messages.map(m => {
    const a = AGENTS.find(x => x.id === m.agentId);
    const label = a ? `[${a.name}]` : '[Human]';
    return `${label}: ${m.content}`;
  }).join('\n\n');

  // Collect answered escalations relevant to this agent
  const answeredEscalations = session.escalations
    .filter(e => e.answered && e.agentId === agentId)
    .map(e => `Human answered your question "${e.question}": ${e.answer}`)
    .join('\n');

  // Also include escalation answers from other agents as shared context
  const otherAnswers = session.escalations
    .filter(e => e.answered && e.agentId !== agentId)
    .map(e => {
      const a = AGENTS.find(x => x.id === e.agentId);
      return `[Human responded to ${a ? a.name : 'agent'}]: Q: "${e.question}" A: ${e.answer}`;
    })
    .join('\n');

  let userContent = `PROBLEM: ${session.problem}\n\nCURRENT PHASE: ${phaseName}\n\n`;

  if (priorMessages) {
    userContent += `PRIOR DELIBERATION:\n${priorMessages}\n\n`;
  }

  if (answeredEscalations) {
    userContent += `YOUR ESCALATION ANSWERS:\n${answeredEscalations}\n\n`;
  }

  if (otherAnswers) {
    userContent += `SHARED HUMAN INPUT:\n${otherAnswers}\n\n`;
  }

  userContent += `Now provide your contribution as ${agent.name} (${agent.role}) for the ${phaseName} phase. Stay in character. Be concise but thorough.`;

  if (phase === PHASES.length - 1 && agentId === 'process-architect') {
    userContent += `\n\nThis is the FINAL SYNTHESIS phase. Deliver a comprehensive summary that includes:
1. Key findings and recommendations
2. Confidence levels (high/medium/low) for each recommendation
3. Key uncertainties and open questions
4. Dissenting views and their merit
5. Recommended next steps
Format this as a clear, actionable brief.`;
  }

  return [{ role: 'user', content: userContent }];
}

// ─── Run a single agent turn ─────────────────────────────────────────
async function runAgentTurn(session, agentId, phase) {
  const agent = AGENTS.find(a => a.id === agentId);

  // Update state to thinking
  session.agentStates[agentId] = 'thinking';
  broadcast({ type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });

  try {
    const messages = buildContext(session, agentId, phase);
    const response = await callAnthropic(agent.systemPrompt, messages, agentId);

    // Update state to speaking
    session.agentStates[agentId] = 'speaking';
    broadcast({ type: 'agent-state', agentId, state: 'speaking', sessionId: session.id });

    // Store message
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      agentId,
      agentName: agent.name,
      agentEmoji: agent.emoji,
      agentColor: agent.color,
      content: response,
      phase: PHASES[phase].name,
      timestamp: Date.now()
    };
    session.messages.push(msg);
    broadcast({ type: 'message', ...msg, sessionId: session.id });

    // Extract and broadcast escalations
    const escalations = extractEscalations(response, agentId, session.id);
    escalations.forEach(esc => {
      session.escalations.push(esc);
      broadcast({ type: 'escalation', ...esc, agentName: agent.name, agentEmoji: agent.emoji });
    });

    // Return to idle
    session.agentStates[agentId] = 'idle';
    broadcast({ type: 'agent-state', agentId, state: 'idle', sessionId: session.id });

    // Small delay between agents for readability
    await new Promise(r => setTimeout(r, 500));

  } catch (err) {
    console.error(`Agent ${agentId} error:`, err.message);
    session.agentStates[agentId] = 'idle';
    broadcast({ type: 'agent-state', agentId, state: 'idle', sessionId: session.id });
    broadcast({
      type: 'error',
      agentId,
      message: `${agent.name} encountered an error: ${err.message}`,
      sessionId: session.id
    });
  }
}

// ─── Run deliberation ────────────────────────────────────────────────
async function runDeliberation(session) {
  for (let phaseIdx = 0; phaseIdx < PHASES.length; phaseIdx++) {
    if (!session.active) break;

    session.phase = phaseIdx;
    const phase = PHASES[phaseIdx];

    broadcast({
      type: 'phase-change',
      phase: phaseIdx,
      phaseName: phase.name,
      phaseAgents: phase.agents,
      sessionId: session.id
    });

    // Run each agent in this phase sequentially
    for (const agentId of phase.agents) {
      if (!session.active) break;

      // Check for pending escalations — pause if any unanswered
      const pending = session.escalations.filter(e => !e.answered);
      if (pending.length > 0) {
        broadcast({
          type: 'waiting-for-human',
          pendingCount: pending.length,
          sessionId: session.id
        });

        // Wait up to 5 minutes for answers, checking every 2 seconds
        let waited = 0;
        while (session.escalations.some(e => !e.answered) && waited < 300000 && session.active) {
          await new Promise(r => setTimeout(r, 2000));
          waited += 2000;
        }

        if (waited >= 300000) {
          broadcast({
            type: 'escalation-timeout',
            message: 'Proceeding without human input (timeout)',
            sessionId: session.id
          });
        }
      }

      await runAgentTurn(session, agentId, phaseIdx);
    }
  }

  session.active = false;
  broadcast({ type: 'deliberation-complete', sessionId: session.id });
}

// ─── WebSocket handling ──────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send current sessions list
  const sessionList = Array.from(sessions.values()).map(s => ({
    id: s.id,
    problem: s.problem,
    phase: s.phase,
    active: s.active,
    messageCount: s.messages.length,
    createdAt: s.createdAt
  }));
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList }));

  // Send agent definitions
  ws.send(JSON.stringify({
    type: 'agents',
    agents: AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat }))
  }));

  // Send phase definitions
  ws.send(JSON.stringify({ type: 'phases', phases: PHASES }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'new-session': {
          const session = createSession(msg.problem);
          broadcast({
            type: 'session-created',
            session: {
              id: session.id,
              problem: session.problem,
              phase: session.phase,
              active: session.active,
              createdAt: session.createdAt
            }
          });
          // Start deliberation asynchronously
          runDeliberation(session).catch(err => {
            console.error('Deliberation error:', err);
            broadcast({ type: 'error', message: err.message, sessionId: session.id });
          });
          break;
        }

        case 'escalation-response': {
          const session = sessions.get(msg.sessionId);
          if (!session) break;
          const esc = session.escalations.find(e => e.id === msg.escalationId);
          if (esc) {
            esc.answered = true;
            esc.answer = msg.answer;
            broadcast({
              type: 'escalation-answered',
              escalationId: esc.id,
              answer: msg.answer,
              sessionId: session.id
            });
          }
          break;
        }

        case 'join-session': {
          const session = sessions.get(msg.sessionId);
          if (session) {
            // Send full session state
            ws.send(JSON.stringify({
              type: 'session-state',
              session: {
                id: session.id,
                problem: session.problem,
                phase: session.phase,
                active: session.active,
                messages: session.messages,
                escalations: session.escalations,
                agentStates: session.agentStates,
                createdAt: session.createdAt
              }
            }));
          }
          break;
        }

        case 'stop-session': {
          const session = sessions.get(msg.sessionId);
          if (session) {
            session.active = false;
            broadcast({ type: 'session-stopped', sessionId: session.id });
          }
          break;
        }
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// ─── REST endpoints ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, uptime: process.uptime() });
});

app.get('/api/agents', (req, res) => {
  res.json(AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat })));
});

// ─── Start server ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🏛️  AI Research War Room`);
  console.log(`   Server running on http://localhost:${PORT}`);
  console.log(`   WebSocket ready`);
  console.log(`   API Key: ${ANTHROPIC_API_KEY ? '✅ configured' : '❌ missing'}`);
  console.log(`   Model: ${MODEL}\n`);
});
