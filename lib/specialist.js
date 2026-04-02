const { countTokens } = require('./tokens');

const MAX_PROMPT_TOKENS = 500;
const MAX_SPECIALISTS = 3;

/**
 * Initialize specialist spawner with dependencies.
 */
function createSpecialistSpawner(deps) {
  const { db, stmts } = deps;

  /**
   * Spawn specialists for a session based on recommended domains.
   * Reads from agent_templates table. Returns agent objects compatible with core agents.
   * @param {string[]} domains - Recommended specialist domains from fingerprint classifier
   * @param {number} limit - Max specialists to spawn (default 3)
   * @returns {object[]} - Agent objects with id, name, emoji, color, role, hat, systemPrompt
   */
  function spawnSpecialists(domains, limit = MAX_SPECIALISTS) {
    if (!domains || domains.length === 0) return [];

    const agents = [];
    for (const domain of domains.slice(0, limit)) {
      const template = stmts.getAgentTemplateByDomain.get(domain);
      if (!template || !template.active) continue;

      let prompt = template.system_prompt;
      // Truncate if too long
      if (countTokens(prompt) > MAX_PROMPT_TOKENS) {
        const chars = MAX_PROMPT_TOKENS * 4; // rough estimate
        prompt = prompt.slice(0, chars);
      }

      agents.push({
        id: template.id,
        name: template.name,
        emoji: template.emoji,
        color: template.color,
        role: template.role,
        hat: template.hat,
        domain: template.domain,
        systemPrompt: prompt,
        isSpecialist: true,
      });

      // Increment usage count
      stmts.incrementAgentTemplateUsage.run(Date.now(), template.id);
    }

    if (agents.length > 0) {
      console.log(`[specialist] Spawned ${agents.length} specialists: ${agents.map(a => a.name).join(', ')}`);
    }

    return agents;
  }

  /**
   * List all available specialist templates.
   */
  function listTemplates() {
    return stmts.getActiveAgentTemplates.all().map(t => ({
      id: t.id, name: t.name, emoji: t.emoji, color: t.color,
      role: t.role, hat: t.hat, domain: t.domain,
      usage_count: t.usage_count, active: !!t.active,
    }));
  }

  return { spawnSpecialists, listTemplates };
}

module.exports = { createSpecialistSpawner };
