-- ---------------------------------------------------------------------------
-- 0012 — let the worker say what it is
-- ---------------------------------------------------------------------------
--
-- "Demo fixtures — no AI provider" was shown on the judging page of a
-- production deployment that was, at that moment, judging a real cohort
-- against real Gemini.
--
-- The banner was not wrong about its inputs. It described `AI_PROVIDER` and
-- `AI_API_KEY` as read by the *web* application — and judging does not run
-- there. It runs in a separate worker with its own environment, on its own
-- host. The web tier never constructs an AI client and imports exactly one
-- symbol from the AI package: the function that renders this banner. So its
-- AI configuration is not a weak signal about judging, it is no signal at all.
--
-- With `AI_API_KEY` unset on the web tier, `AI_PROVIDER` can only be `demo` or
-- `ollama` — anything else refuses to boot — so the banner had no reachable
-- state other than the two that say judging is not real.
--
-- The fix everyone reaches for first is to copy `AI_PROVIDER` and `AI_API_KEY`
-- onto the web tier so the label comes out right. That puts the provider key on
-- the internet-facing tier that holds admin sessions, in a tier that will never
-- call the provider, to correct a caption. The blast radius of that tier being
-- compromised would grow to include the AI key, and nothing would be judged any
-- differently.
--
-- So the worker reports instead. It knows its provider, its model and its
-- evaluation mode as facts rather than inferences, and the admin page reads
-- what the worker said. The web tier needs no AI configuration at all, and the
-- banner becomes an observation instead of a guess about a process on another
-- machine.
-- ---------------------------------------------------------------------------

create table if not exists worker_status (
  worker_id           text primary key,
  ai_provider         text        not null,
  ai_model            text,
  evaluation_mode     text        not null,
  demo_mode           boolean     not null,
  concurrency         integer     not null,
  driver              text        not null,
  started_at          timestamptz not null,
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

/*
 * Deliberately holds no secret and no learner data.
 *
 * The API key is reported as a boolean at most — never its value, never a
 * prefix. A row here is read by the admin UI to render a caption, and a caption
 * is not worth a place for a key to leak into.
 */

comment on table worker_status is
  'What each judging worker reports about itself. Configuration facts only — never a key, never learner data.';

-- The admin page reads the most recently seen worker.
create index if not exists worker_status_last_seen on worker_status (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- Enabled with no participant policy, like every other operational table
-- (0002). A participant querying this gets zero rows under every query, and
-- that is a property of the policy being absent rather than of any check
-- written here — which is what makes it hold for surfaces nobody has built yet.
alter table worker_status enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- The worker writes here and the admin reads. No delete for either: a worker
-- that has gone away should show as last seen long ago, which is exactly what
-- an operator needs to know, rather than vanishing and leaving the page
-- confidently silent.
grant select, insert, update on worker_status to ohj_worker;
create policy worker_report on worker_status
  for all to ohj_worker using (true) with check (true);

grant select on worker_status to ohj_admin;
create policy admin_read on worker_status
  for select to ohj_admin using (true);
