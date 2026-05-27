-- Migration 016: role presets + escalation severity + synthesis quality
-- Backs the role-presets / escalation-UX / decision-record bundle.
-- escalations.answered_at already exists (001); only severity/default_action/
-- bulk_resolved are new here.

-- Escalation triage. Default 'blocking' so an un-classified escalation is
-- NEVER silently skipped (Red Team: severity must not collapse to optional by
-- omission). default_action carries the forced-choice fallback used when an
-- optional escalation is unanswered at phase end.
ALTER TABLE escalations ADD COLUMN severity TEXT NOT NULL DEFAULT 'blocking';
ALTER TABLE escalations ADD COLUMN default_action TEXT;
ALTER TABLE escalations ADD COLUMN bulk_resolved INTEGER NOT NULL DEFAULT 0;

-- Session role preset + post-session quality 1-tap (USEFUL|PARTIAL|MISLEADING).
-- synthesis_quality is the only honest watch on silent deliberation regression.
ALTER TABLE sessions ADD COLUMN preset_id TEXT;
ALTER TABLE sessions ADD COLUMN synthesis_quality TEXT;

-- research-methods specialist — required for the Scientist preset to be real.
-- One row, existing injection pattern. Covers experimental design, statistical
-- rigor, and reproducibility.
INSERT OR IGNORE INTO agent_templates (id, name, emoji, color, role, hat, domain, system_prompt, created_at, updated_at)
VALUES
  ('specialist-research-methods', 'Research Methodologist', '🔬', '#7fd1ff', 'Experimental Design & Statistical Rigor', 'Scientific Method', 'research-methods',
   'You are a Research Methodologist specialist in the Research War Room. You scrutinize experimental and study design, statistical rigor, and reproducibility. Check: is the design appropriate for the claim (causal vs correlational, paired vs unpaired, controls, randomization, blinding)? Is the statistics sound — adequate power, correct test for the data distribution, multiple-comparisons correction, effect sizes reported (not just p-values), and no p-hacking / HARKing / garden-of-forking-paths? Are the data and methods reproducible (preregistration, code/data availability, sensitivity analyses)? State the strongest threat to validity explicitly, distinguish what the evidence can and cannot support, and recommend the single change that would most strengthen the work. Cite established methodological standards where relevant.',
   strftime('%s','now')*1000, strftime('%s','now')*1000);
