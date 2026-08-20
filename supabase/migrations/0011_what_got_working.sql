-- ---------------------------------------------------------------------------
-- 0011 — "What did your team manage to get working in these two days?"
-- ---------------------------------------------------------------------------
--
-- The third of the three questions added to the learner form. It is context for
-- the two-day-execution category: a beginner team saying, in their own words,
-- what they actually finished.
--
-- It is deliberately not folded into an existing column. `day12_to_day13_changes`
-- means something else, and reusing it would make the stored answer mean one
-- thing to the form and another to whoever reads the table later.
--
-- Worth being explicit about what this is NOT. It is a claim, not proof. The
-- browser run is what establishes whether something works; this answer explains
-- what the team was aiming at and gives their account of the two days. Where the
-- two disagree, the observed product wins — the scoring guidance says so, and
-- this column exists to be weighed, not believed.
-- ---------------------------------------------------------------------------

alter table submissions
  add column if not exists what_got_working text;

comment on column submissions.what_got_working is
  'Learner answer: what the team got working in the two days. Supporting '
  'context for two_day_execution. Never overrides observed product behaviour.';
