-- ---------------------------------------------------------------------------
-- 0009 — submissions that arrive from the Hackathon product
-- ---------------------------------------------------------------------------
--
-- The Judge stops being a place learners visit. The Outskill Hackathon product
-- is the only learner-facing frontend now, and it hands us submissions over an
-- authenticated service-to-service call.
--
-- Two consequences shape this migration.
--
-- The Hackathon product owns identity, not us. It has its own cohort and
-- submission identifiers, and those are the only stable way to talk about a
-- submission across the two systems. They are recorded here and the submission
-- one is unique, which is also what makes ingestion idempotent: a retried
-- delivery finds the existing row instead of creating a second assessment of
-- the same work.
--
-- And we should hold as little about a learner as we can get away with. The
-- Hackathon product knows team members, emails and phone numbers; the Judge
-- does not need any of it to decide whether a product works, so the ingest
-- contract does not accept it. What arrives is what judging reads.
--
-- The snapshot column stores exactly what we were sent. If a score is ever
-- questioned, the answer to "what was it judged on" should not require
-- reconstructing state from three tables and a deploy history.
-- ---------------------------------------------------------------------------

alter table submissions
  add column if not exists external_cohort_id text,
  add column if not exists external_submission_id text,
  -- Where this came from. `outskill_hackathon` for ingested work; null for a
  -- submission created through the Judge's own (now legacy) form.
  add column if not exists source text,
  -- 'open' or 'credentials'. What the browser run has to do to reach the product.
  add column if not exists access_mode text,
  add column if not exists loom_url text,
  add column if not exists deck_url text,
  -- Exactly what the Hackathon product sent, minus the credentials, which are
  -- encrypted into submission_credentials rather than kept in the clear here.
  add column if not exists ingest_snapshot jsonb;

-- The idempotency key. A repeated delivery of the same external submission
-- cannot create a second row, whatever the caller does.
create unique index if not exists submissions_external_submission_id
  on submissions (external_submission_id)
  where external_submission_id is not null;

create index if not exists submissions_external_cohort
  on submissions (external_cohort_id)
  where external_cohort_id is not null;

comment on column submissions.ingest_snapshot is
  'The exact payload judging was based on, as delivered. Never contains credentials.';

-- The worker reads submissions and has SELECT on them already (0006), which
-- covers the new columns. Nothing here grants it anything further.
