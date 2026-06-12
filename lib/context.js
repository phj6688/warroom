// F6 — Token-budget-aware context builder, extracted from server.js.
//
// Two responsibilities:
//   1. Assemble the user-content string an agent sees for a turn (problem,
//      phase, files, human interjections, prior deliberation, escalation
//      answers, role instructions).
//   2. Enforce a hard token budget. The pre-S4 implementation did
//      `userContent.slice(0, ratio)` which silently cut the trailing
//      "Stay in character" instructions out — every trim corrupted the
//      prompt. This module instead drops oldest priorMessages one entry at
//      a time, rebuilding the user content each iteration with the static
//      header/footer blocks intact, until the result fits.
//
// The "Stay in character" marker is asserted on every return path. If it is
// ever missing the function throws — that is preferable to handing a chopped
// prompt to an LLM.

const { getAgentsForSession } = require('./agents');
const { PHASES } = require('./phases');
const { countTokens, contextBudget } = require('./tokens');
const { log } = require('./logger');

const INSTRUCTION_MARKER = 'Stay in character';

// Inline copy of memory.injectMemory's pure-string output. Mirrors the live
// implementation in lib/memory.js so context.js does not have to drag the
// whole memory manager (and its DB handle) into the dependency graph.
const MEMORY_TOKEN_BUDGET = 2000;
function estimateTokens(s) { return Math.ceil((s || '').length / 4); }

function injectMemory(memories) {
  if (!memories || memories.length === 0) return '';
  let text = '=== RELEVANT PRIOR SESSIONS ===\n';
  let tokenCount = estimateTokens(text);
  for (const mem of memories) {
    const entry = `\n--- Prior Session (similarity: ${(mem.similarity * 100).toFixed(0)}%${mem.quality_score ? `, quality: ${mem.quality_score.toFixed(1)}` : ''}) ---\nProblem: ${mem.problem}\n`;
    const entryTokens = estimateTokens(entry);
    if (tokenCount + entryTokens > MEMORY_TOKEN_BUDGET) {
      text += `\n[Additional similar session found but omitted due to context budget]\n`;
      break;
    }
    if (mem.summary) {
      const fullEntry = entry + `Summary: ${mem.summary}\n`;
      const fullTokens = estimateTokens(fullEntry);
      if (tokenCount + fullTokens <= MEMORY_TOKEN_BUDGET) {
        text += fullEntry;
        tokenCount += fullTokens;
        continue;
      }
    }
    text += entry;
    tokenCount += entryTokens;
  }
  text += '=== END PRIOR SESSIONS ===\n\n';
  return text;
}

// Pure rebuild — given the static parts and a (possibly trimmed) array of
// prior message objects, return the assembled user content. The trim loop
// calls this in a tight cycle, so it must not touch I/O or do anything that
// changes between identical calls.
function rebuildUserContent({
  problem,
  phaseName,
  agent,
  humanMessages,
  priorMessageObjs,
  answeredEscalationsText,
  otherAnswersText,
  continuationText,
  memoryText,
  isFinalSynthesis,
  synthesisHeaders,
}) {
  let content = `PROBLEM: ${problem}\n\nCURRENT PHASE: ${phaseName}\n\n`;

  if (continuationText) content += continuationText;
  if (memoryText) content += memoryText;

  if (humanMessages && humanMessages.length > 0) {
    content += `HUMAN INTERJECTIONS (from the problem owner):\n`;
    humanMessages.forEach(hm => {
      content += `[Human @ ${new Date(hm.timestamp).toLocaleTimeString()}]: ${hm.content}\n`;
    });
    content += '\n';
  }

  if (priorMessageObjs && priorMessageObjs.length > 0) {
    const priorText = priorMessageObjs
      .map(p => `[${p.author}]: ${p.content}`)
      .join('\n\n');
    content += `PRIOR DELIBERATION:\n${priorText}\n\n`;
  }

  if (answeredEscalationsText) {
    content += `YOUR ESCALATION ANSWERS:\n${answeredEscalationsText}\n\n`;
  }
  if (otherAnswersText) {
    content += `SHARED HUMAN INPUT:\n${otherAnswersText}\n\n`;
  }

  content += `Now provide your contribution as ${agent.name} (${agent.role}) for the ${phaseName} phase. ${INSTRUCTION_MARKER}. Be concise but thorough.

HUMAN ESCALATIONS — use the \`escalate_to_human\` tool sparingly and in a fixed shape.
The human's attention is the scarcest resource in this room. Most framing choices are YOURS to make: decide, state the assumption in your response, and move on. Escalate ONLY when an ambiguity genuinely changes the scope, the success criteria, or the final recommendation — and only the human can resolve it.

When you DO escalate, every question MUST be a forced choice with a stated default:
- Phrase the \`question\` as: "QUESTION — [A] <option> / [B] <option> — default: A". If you cannot name two genuinely competing options, you do not need the human — decide and announce it instead.
- Set \`severity\`: "blocking" only if the deliberation cannot sensibly continue without the answer; "optional" if you have a safe default and merely want confirmation. Optional questions are auto-resolved to your default if unanswered.
- Set \`default_action\`: in one clause, exactly what you will assume if the human does not answer (your option A).
Never ask the same question twice. Write your full response first, then call the tool.`;

  if (isFinalSynthesis) {
    const headers = (synthesisHeaders && synthesisHeaders.length)
      ? synthesisHeaders
      : ['DECISION', 'RATIONALE', 'CONFIDENCE', 'UNCERTAINTIES', 'DISSENT', 'NEXT ACTIONS'];
    content += `\n\nThis is the FINAL SYNTHESIS phase. Deliver a comprehensive, actionable brief. Structure it with EXACTLY these section headers, each on its own line as a markdown H2 (e.g. "## ${headers[0]}"), in this order:
${headers.map(h => `## ${h}`).join('\n')}
Under each header, write tight, decision-grade prose. State confidence (high/medium/low) where you make a recommendation, and name dissenting views and their merit. Use these exact headers verbatim so the brief can be rendered as a structured Decision Record.`;
  }

  return content;
}

function buildContext(session, agentId, phase) {
  const sessionAgents = getAgentsForSession(session);
  const agent = sessionAgents.find(a => a.id === agentId);
  if (!agent) throw new Error(`buildContext: unknown agent ${agentId}`);

  const phaseObj = PHASES[phase];
  if (!phaseObj) throw new Error(`buildContext: invalid phase index ${phase}`);
  const phaseName = phaseObj.name;
  const isFinalSynthesis = (phase === PHASES.length - 1) && (agentId === 'process-architect');

  // Prior deliberation as an array of {author, content} objects so the trim
  // loop can drop oldest entries one at a time without rejoining strings.
  const priorMessageObjs = (session.messages || []).map(m => {
    const a = sessionAgents.find(x => x.id === m.agentId);
    return { author: a ? a.name : 'Human', content: m.content };
  });

  const answeredEscalationsText = (session.escalations || [])
    .filter(e => e.answered && e.agentId === agentId)
    .map(e => `Human answered your question "${e.question}": ${e.answer}`)
    .join('\n');

  const otherAnswersText = (session.escalations || [])
    .filter(e => e.answered && e.agentId !== agentId)
    .map(e => {
      const a = sessionAgents.find(x => x.id === e.agentId);
      return `[Human responded to ${a ? a.name : 'agent'}]: Q: "${e.question}" A: ${e.answer}`;
    })
    .join('\n');

  // Memory injection only fires for Process Architect in phase 0 with prior
  // sessions retrieved upstream. session._memoryText is the pre-rendered
  // string set by server.js after retrieveSimilar; injectMemory is the
  // local fallback so the function still works when called in isolation.
  let memoryText = '';
  let continuationText = '';
  if (phase === 0 && agentId === 'process-architect') {
    if (session._continuationText) continuationText = session._continuationText;
    if (session._memoryText) memoryText = session._memoryText;
    else if (session._memories && session._memories.length > 0) {
      memoryText = injectMemory(session._memories);
    }
  }

  // Preset-specific synthesis headers (engineer vs scientist vs generalist)
  // make the final brief parseable into a Decision Record without any extra
  // LLM call. session._preset is the resolved preset config set by server.js.
  const synthesisHeaders = (session._preset && Array.isArray(session._preset.synthesis_headers))
    ? session._preset.synthesis_headers
    : null;

  const baseArgs = {
    problem: session.problem,
    phaseName,
    agent,
    humanMessages: session.humanMessages,
    answeredEscalationsText,
    otherAnswersText,
    continuationText,
    memoryText,
    isFinalSynthesis,
    synthesisHeaders,
  };

  const model = process.env.MODEL || 'anthropic/claude-opus-4-8';
  const budget = contextBudget(model);
  const systemTokens = countTokens(agent.systemPrompt || '');

  let userContent = rebuildUserContent({ ...baseArgs, priorMessageObjs });
  let totalTokens = systemTokens + countTokens(userContent);
  const initialUtilization = totalTokens / budget;

  if (initialUtilization > 0.9) {
    // Drop oldest priors one at a time. Rebuild after each drop so the
    // header (PROBLEM/PHASE/files/...) and the trailing instructions stay
    // intact for every iteration.
    let trimmed = priorMessageObjs.slice();
    while (trimmed.length > 0) {
      trimmed.shift();
      const rebuilt = rebuildUserContent({ ...baseArgs, priorMessageObjs: trimmed });
      const rebuiltTotal = systemTokens + countTokens(rebuilt);
      if (rebuiltTotal <= budget * 0.8) {
        const droppedCount = priorMessageObjs.length - trimmed.length;
        log.warn({ agentId, droppedCount, before: totalTokens, after: rebuiltTotal }, 'context trimmed: dropped oldest priors');
        if (!rebuilt.includes(INSTRUCTION_MARKER)) {
          throw new Error(`buildContext: trim dropped instruction marker for ${agentId}`);
        }
        return [{ role: 'user', content: rebuilt }];
      }
    }
    // Even with zero priors we're still over budget. Try one last rebuild
    // with no priors, in case the static header alone fits.
    const bare = rebuildUserContent({ ...baseArgs, priorMessageObjs: [] });
    if (systemTokens + countTokens(bare) <= budget * 0.8) {
      log.warn({ agentId, droppedCount: priorMessageObjs.length }, 'context trimmed: dropped ALL priors');
      if (!bare.includes(INSTRUCTION_MARKER)) {
        throw new Error(`buildContext: trim dropped instruction marker for ${agentId}`);
      }
      return [{ role: 'user', content: bare }];
    }
    throw new Error(`Cannot fit context for ${agentId} even with zero prior messages (system=${systemTokens}, budget=${budget})`);
  }

  if (initialUtilization > 0.8) {
    log.warn({ agentId, utilization: initialUtilization, totalTokens, budget }, 'context near budget');
  }

  if (!userContent.includes(INSTRUCTION_MARKER)) {
    throw new Error(`buildContext: instruction marker missing for ${agentId}`);
  }
  return [{ role: 'user', content: userContent }];
}

module.exports = { buildContext, rebuildUserContent, INSTRUCTION_MARKER };
