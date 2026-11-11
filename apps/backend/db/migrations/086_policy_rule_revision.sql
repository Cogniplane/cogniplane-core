-- A counter for each Policy Center rule. A rule edit names the revision that
-- the admin loaded, and the save is refused when the rule has a newer
-- revision, so a save from a stale form cannot replace a newer edit. Each
-- edit adds 1, and a reorder adds 1 to each rule that it moves. See
-- PolicyRuleStore.update. The check does not use updated_at: a reorder sets
-- it on every rule, and a JavaScript Date drops its microseconds.
--
-- A NOT NULL column with a constant default changes only the catalog. Every
-- existing rule starts at revision 1.
ALTER TABLE policy_rule ADD COLUMN revision integer NOT NULL DEFAULT 1;
