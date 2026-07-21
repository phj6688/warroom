-- B7 (HLB-797) — terminal outcome for a deliberation.
--
-- Before this, a run whose every agent turn errored (for example a provider
-- rate-limit / model_cooldown storm) still finished with active=0 and no
-- distinguishing mark, so it was indistinguishable from a real completion and
-- was scored as quality, polluting the metric with infrastructure failures.
--
-- Additive and nullable: existing rows read NULL, which the read path treats as
-- a legacy 'complete'. `failed_at` is stamped only for a failed run.
ALTER TABLE sessions ADD COLUMN outcome TEXT;
ALTER TABLE sessions ADD COLUMN failed_at INTEGER;
