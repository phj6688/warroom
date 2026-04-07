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
  files,
  humanMessages,
  priorMessageObjs,
  answeredEscalationsText,
  otherAnswersText,
  memoryText,
  isFinalSynthesis,
}) {
  let content = `PROBLEM: ${problem}\n\nCURRENT PHASE: ${phaseName}\n\n`;

  if (memoryText) content += memoryText;

  if (files && files.length > 0) {
    content += `ATTACHED FILES:\n`;
    files.forEach(f => {
      content += `--- ${f.name} (${f.type || 'unknown'}) ---\n`;
      if (f.content) {
        content += f.content.slice(0, 10000) + (f.content.length > 10000 ? '\n[...truncated]' : '') + '\n';
      } else {
        content += `[Binary file, ${f.size} bytes]\n`;
      }
    });
    content += '\n';
  }

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

  content += `Now provide your contribution as ${agent.name} (${agent.role}) for the ${phaseName} phase. ${INSTRUCTION_MARKER}. Be concise but thorough.`;

  if (isFinalSynthesis) {
    content += `\n\nThis is the FINAL SYNTHESIS phase. Deliver a comprehensive summary that includes:
1. Key findings and recommendations
2. Confidence levels (high/medium/low) for each recommendation
3. Key uncertainties and open questions
4. Dissenting views and their merit
5. Recommended next steps
Format this as a clear, actionable brief.`;
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
  if (phase === 0 && agentId === 'process-architect') {
    if (session._memoryText) memoryText = session._memoryText;
    else if (session._memories && session._memories.length > 0) {
      memoryText = injectMemory(session._memories);
    }
  }

  const baseArgs = {
    problem: session.problem,
    phaseName,
    agent,
    files: session.files,
    humanMessages: session.humanMessages,
    answeredEscalationsText,
    otherAnswersText,
    memoryText,
    isFinalSynthesis,
  };

  const model = process.env.MODEL || 'anthropic/claude-sonnet-4-5';
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
