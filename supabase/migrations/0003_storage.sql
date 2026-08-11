-- ==========================================================================
-- Storage buckets
--
-- Every bucket is PRIVATE. No public bucket holds assessment material.
-- All reads go through short-lived signed URLs minted server-side after an
-- authorisation check.
-- ==========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Participant uploads. 25 MB matches the portal's client-side limit.
  ('submission-decks', 'submission-decks', false, 26214400, array['application/pdf']),

  -- Screenshots captured while testing a participant product.
  ('submission-screenshots', 'submission-screenshots', false, 10485760,
   array['image/png', 'image/jpeg', 'image/webp']),

  -- Per-step browser evidence.
  ('browser-evidence', 'browser-evidence', false, 52428800,
   array['image/png', 'image/jpeg', 'application/json', 'text/plain']),

  -- Playwright traces. Large, and the most sensitive artifact we hold: a trace
  -- can contain screenshots of a product in an authenticated state.
  ('traces', 'traces', false, 209715200, array['application/zip']),

  -- Generated internal reports.
  ('internal-reports', 'internal-reports', false, 26214400,
   array['application/pdf', 'application/json', 'text/markdown']),

  -- Templates and instructions. The only bucket whose contents may be exposed
  -- to participants, and only for rows flagged participant-visible.
  ('admin-resources', 'admin-resources', false, 52428800, null)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- --------------------------------------------------------------------------
-- Object policies
--
-- Deliberately restrictive: no anon or authenticated role gets a direct read.
-- The application holds the service role and mints signed URLs itself, so an
-- authorisation check always happens in our code before a URL exists.
-- --------------------------------------------------------------------------

alter table storage.objects enable row level security;

-- Participants may upload their own deck into their own submission's prefix.
-- The path convention is <cohort_id>/<submission_id>/<filename>.
create policy participant_upload_deck on storage.objects
  for insert to ohj_participant
  with check (
    bucket_id = 'submission-decks'
    and (storage.foldername(name))[2] in (
      select id::text from submissions where team_id = current_team_id()
    )
  );

-- No participant SELECT policy on storage.objects. Participants never read
-- from storage directly; the application serves a signed URL after checking
-- that the object belongs to them.

create policy admin_manage_objects on storage.objects
  for all to ohj_admin
  using (is_admin())
  with check (is_admin());

create policy worker_write_evidence on storage.objects
  for insert to ohj_worker
  with check (bucket_id in ('submission-screenshots', 'browser-evidence', 'traces'));

create policy worker_read_decks on storage.objects
  for select to ohj_worker
  using (bucket_id in ('submission-decks', 'submission-screenshots', 'browser-evidence'));

-- ==========================================================================
-- Retention note
--
-- Traces and evidence are retained for 90 days by default; submissions and
-- reports for 90 days; credentials are destroyed at judging finalisation.
-- The deletion job refuses to run outside production and in demo mode
-- (ADR-019), so a policy written for production cannot destroy local work.
-- ==========================================================================
