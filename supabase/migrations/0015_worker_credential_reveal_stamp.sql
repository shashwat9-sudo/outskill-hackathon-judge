-- 0015: let the worker stamp the credential reveal it is allowed to perform.
--
-- The worker decrypts a team's login at the moment of use (revealCredentials
-- in packages/shared/src/data/postgres/repositories/submissions.ts). That path
-- selects the ciphertext — which 0002's policy and 0006's grant allow — and
-- then records that a reveal happened by setting `last_revealed_at`, which
-- neither allows. In production every reveal by ohj_worker therefore failed
-- with "permission denied for table submission_credentials", at the moment
-- browser testing needed the login, and every credential-protected product
-- was marked failed. AIAP C14: eight of eleven such products, none of which
-- was ever opened.
--
-- Least privilege, kept: the grant is on that ONE column, so an UPDATE that
-- names a ciphertext column, `deleted_at`, `updated_at` or anything else is
-- still refused by the grant layer with "permission denied for table"; the
-- policy layer (RLS is forced on this table) additionally restricts the
-- rows to live credential records. The worker still cannot insert, delete
-- or read anything it could not read before, and admin/participant policies
-- are untouched. Additive: no data changes, no existing migration edited.
--
-- Nothing here weakens what the reveal path promises: the timestamp is the
-- audit trail that a reveal occurred, and it is now written by the role that
-- performs the reveal, which is the only role that should.

grant update (last_revealed_at) on submission_credentials to ohj_worker;

drop policy if exists worker_stamp_credential_reveal on submission_credentials;
create policy worker_stamp_credential_reveal on submission_credentials
  for update to ohj_worker
  using (deleted_at is null)
  with check (deleted_at is null);

comment on policy worker_stamp_credential_reveal on submission_credentials is
  'The worker may update a live credential row — and, by the column grant, only last_revealed_at — to record that it revealed the credentials for judging.';
