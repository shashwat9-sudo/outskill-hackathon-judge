/**
 * Teams, invites and access codes.
 *
 * The access-code methods are the ones with teeth. Generating a code is three
 * writes that must all happen or none: revoke the old code, insert the new one
 * at the next version, and revoke every session minted under the old version.
 * Half of that is worse than none — a team could hold a code that works while
 * their teammates stay signed in under a code that no longer exists.
 */

import type { Team, TeamInvite, TeamMember } from '../../types';
import type {
  AccessCodeStatus,
  GeneratedAccessCodeRow,
  LearnerAllocationGroup,
  LearnerAllocationResult,
  TeamImportResult,
  TeamStore,
} from '../../store';
import { RowNotFoundError, isUniqueViolation, type SqlClient, type SqlDatabase } from '../client';
import { mapMaybe, mapRow, mapRows, toNumber } from '../rows';
import { generateAccessCode } from '../../../security/access-code';
import { generateInviteToken } from '../../../security/crypto';

export function buildTeamStore(db: SqlDatabase): TeamStore {
  return {
    async listTeams(cohortId) {
      // One query per relation rather than a join with duplicated team columns:
      // a 500-team cohort with members would otherwise return thousands of rows
      // that all have to be de-duplicated in memory.
      const teams = mapRows<Team>(
        (await db.query('select * from teams where cohort_id = $1 order by group_number', [cohortId]))
          .rows,
      );
      if (teams.length === 0) return [];

      const ids = teams.map((t) => t.id);
      const members = mapRows<TeamMember>(
        (
          await db.query(
            'select * from team_members where team_id = any($1::uuid[]) order by display_order',
            [ids],
          )
        ).rows,
      );
      // Only the live invite. Superseded rows are kept for history, so an
      // unfiltered read would return several per team and pick one at random.
      const invites = mapRows<TeamInvite>(
        (
          await db.query(
            `select distinct on (team_id) *
               from team_invites
              where team_id = any($1::uuid[]) and revoked_at is null
              order by team_id, issued_at desc`,
            [ids],
          )
        ).rows,
      );

      const byTeam = new Map<string, TeamMember[]>();
      for (const member of members) {
        const list = byTeam.get(member.teamId) ?? [];
        list.push(member);
        byTeam.set(member.teamId, list);
      }
      const inviteByTeam = new Map(invites.map((i) => [i.teamId, i]));

      return teams.map((team) => ({
        ...team,
        members: byTeam.get(team.id) ?? [],
        invite: inviteByTeam.get(team.id) ?? null,
      }));
    },

    async getTeam(id) {
      const { rows } = await db.query('select * from teams where id = $1', [id]);
      return mapMaybe<Team>(rows);
    },

    async importTeams(cohortId, rows) {
      const created: Team[] = [];
      const skipped: TeamImportResult['skipped'] = [];
      const invites: TeamImportResult['invites'] = [];

      // Each row is its own transaction. One malformed row must not discard the
      // 499 good ones — an import of a real roster always has a few problems,
      // and re-uploading the whole file to fix one line is worse than a report.
      for (const [index, row] of rows.entries()) {
        const rowNumber = index + 2; // 1-based, plus the header line
        try {
          const outcome = await db.transaction(async (tx) => {
            const inserted = await tx.query(
              `insert into teams (cohort_id, group_number, lead_name, lead_email, lead_phone)
               values ($1, $2, $3, $4, $5)
               returning *`,
              [cohortId, row.groupNumber, row.leadName, row.leadEmail, row.leadPhone],
            );
            const team = mapRow<Team>(inserted.rows[0] as Record<string, unknown>);
            const invite = await issueInvite(tx, team.id);
            return { team, token: invite.token };
          });

          created.push(outcome.team);
          invites.push({
            teamId: outcome.team.id,
            groupNumber: row.groupNumber,
            leadEmail: row.leadEmail,
            token: outcome.token,
          });
        } catch (error) {
          skipped.push({
            row: rowNumber,
            groupNumber: row.groupNumber,
            reason: isUniqueViolation(error)
              ? `Group ${row.groupNumber} already exists in this cohort.`
              : error instanceof Error
                ? error.message
                : 'Could not import this row.',
          });
        }
      }

      return { created, skipped, invites };
    },

    /**
     * Import the learner allocation sheet.
     *
     * One transaction per group, not one for the whole sheet. A 1,000-learner
     * import always has a few bad rows, and discarding 99 good groups because
     * group 100 failed means the operator re-uploads and re-checks everything.
     *
     * Within a group the work is atomic: a team with half its members is worse
     * than a team that failed outright, because the failure is reported and the
     * half-import looks like it worked.
     */
    async importLearnerAllocation(cohortId, groups) {
      const result: LearnerAllocationResult = {
        teamsCreated: 0,
        teamsMatched: 0,
        learnersAdded: 0,
        learnersUpdated: 0,
        learnersUnchanged: 0,
        whatsappLinksSet: 0,
        departed: [],
        failed: [],
      };

      for (const group of groups) {
        try {
          const outcome = await db.transaction((tx) => importGroup(tx, cohortId, group));
          result.teamsCreated += outcome.created ? 1 : 0;
          result.teamsMatched += outcome.created ? 0 : 1;
          result.learnersAdded += outcome.added;
          result.learnersUpdated += outcome.updated;
          result.learnersUnchanged += outcome.unchanged;
          result.whatsappLinksSet += outcome.linkSet ? 1 : 0;
          result.departed.push(...outcome.departed);
        } catch (error) {
          result.failed.push({
            groupNumber: group.groupNumber,
            reason: error instanceof Error ? error.message : 'Could not import this group.',
          });
        }
      }

      return result;
    },

    async generateInvite(teamId) {
      return db.transaction(async (tx) => {
        const { invite, token } = await issueInvite(tx, teamId);
        return { invite, token };
      });
    },

    async revokeInvite(teamId) {
      await db.query(
        'update team_invites set revoked_at = now() where team_id = $1 and revoked_at is null',
        [teamId],
      );
    },

    // ----------------------------------------------------------------------
    // Access codes
    // ----------------------------------------------------------------------

    async generateAccessCodes(input) {
      // Which teams need a code. Without `regenerate`, only those that have
      // none or whose code was revoked — so re-running after a late import does
      // not disturb teams already holding a working code.
      const { rows: targets } = await db.query(
        `select t.id, t.group_number, t.lead_name, t.lead_email, t.whatsapp_link,
                (ac.id is not null) as has_live_code,
                (select count(*) from team_members m where m.team_id = t.id) as member_count
           from teams t
           left join team_access_codes ac
             on ac.team_id = t.id and ac.revoked_at is null
          where t.cohort_id = $1
            and t.status = 'active'
            and ($2::uuid[] is null or t.id = any($2::uuid[]))
          order by t.group_number`,
        [input.cohortId, input.teamIds ?? null],
      );

      const results: GeneratedAccessCodeRow[] = [];

      for (const raw of targets) {
        const team = raw as {
          id: string;
          group_number: number;
          lead_name: string | null;
          lead_email: string | null;
          whatsapp_link: string | null;
          has_live_code: boolean;
          member_count: unknown;
        };
        if (team.has_live_code && !input.regenerate) continue;

        // Generated outside the transaction: Argon2id hashing is deliberately
        // slow, and holding a transaction open across it would pin a connection
        // for the whole cohort.
        const generated = await generateAccessCode();

        await db.transaction(async (tx) => {
          const previous = await tx.query(
            `select version from team_access_codes
              where team_id = $1 order by version desc limit 1`,
            [team.id],
          );
          const nextVersion =
            previous.rows.length > 0 ? toNumber((previous.rows[0] as { version: unknown }).version) + 1 : 1;

          await tx.query(
            'update team_access_codes set revoked_at = now() where team_id = $1 and revoked_at is null',
            [team.id],
          );
          await tx.query(
            `insert into team_access_codes
               (team_id, cohort_id, group_number, code_hash, version)
             values ($1, $2, $3, $4, $5)`,
            [team.id, input.cohortId, team.group_number, generated.hash, nextVersion],
          );
          // Anyone editing under the old code is signed out. This is what makes
          // "regenerate" and "sign everyone out" the same operation.
          await tx.query(
            'update participant_sessions set revoked_at = now() where team_id = $1 and revoked_at is null',
            [team.id],
          );
        });

        results.push({
          teamId: team.id,
          groupNumber: team.group_number,
          leadName: team.lead_name,
          leadEmail: team.lead_email,
          whatsappLink: team.whatsapp_link,
          memberCount: toNumber(team.member_count),
          code: generated.formatted,
          regenerated: team.has_live_code,
        });
      }

      return results;
    },

    async listAccessCodeStatus(cohortId) {
      const { rows } = await db.query(
        `select t.id                                as team_id,
                t.group_number,
                t.lead_name,
                t.lead_email,
                ac.id is not null                   as has_code,
                coalesce(ac.version, 0)             as version,
                ac.created_at,
                ac.revoked_at,
                ac.last_verified_at,
                coalesce(ac.verify_count, 0)        as verify_count,
                (select count(*)::int
                   from participant_sessions ps
                  where ps.team_id = t.id
                    and ps.revoked_at is null
                    and ps.expires_at > now())      as active_sessions,
                (select va.locked_until
                   from verification_attempts va
                  where va.cohort_id = t.cohort_id
                    and va.group_number = t.group_number
                    and va.locked_until > now()
                  order by va.locked_until desc
                  limit 1)                          as locked_until
           from teams t
           left join team_access_codes ac
             on ac.team_id = t.id and ac.revoked_at is null
          where t.cohort_id = $1
          order by t.group_number`,
        [cohortId],
      );

      return rows.map((row) => {
        const status = mapRow<AccessCodeStatus>(row);
        return {
          ...status,
          version: toNumber(status.version),
          verifyCount: toNumber(status.verifyCount),
          activeSessions: toNumber(status.activeSessions),
        };
      });
    },

    async revokeAccessCode(teamId) {
      await db.transaction(async (tx) => {
        await tx.query(
          'update team_access_codes set revoked_at = now() where team_id = $1 and revoked_at is null',
          [teamId],
        );
        // Revoking a code that left its sessions alive would not be a revocation.
        await tx.query(
          'update participant_sessions set revoked_at = now() where team_id = $1 and revoked_at is null',
          [teamId],
        );
      });
    },

    async restoreAccessCode(teamId) {
      // Un-revokes the most recently revoked code, for a revocation made in
      // error. It does not resurrect sessions: those were ended, and a team
      // signing in again is the correct, visible outcome.
      const { rowCount } = await db.query(
        `update team_access_codes
            set revoked_at = null
          where id = (
            select id from team_access_codes
             where team_id = $1 and revoked_at is not null
             order by version desc limit 1
          )
            and not exists (
              select 1 from team_access_codes
               where team_id = $1 and revoked_at is null
            )`,
        [teamId],
      );
      if (rowCount === 0) {
        throw new Error(
          'Nothing to restore: this team either has no revoked code, or already has a live one.',
        );
      }
    },

    async clearVerificationLockout(cohortId, groupNumber) {
      await db.query(
        `update verification_attempts
            set attempts = 0, locked_until = null, window_started_at = now()
          where cohort_id = $1 and group_number = $2`,
        [cohortId, groupNumber],
      );
    },
  };
}

/**
 * Issue an invite, replacing any existing one.
 *
 * Only the hash is stored; the plaintext token is returned once and cannot be
 * recovered afterwards, exactly like an access code.
 */
async function issueInvite(
  tx: SqlClient,
  teamId: string,
): Promise<{ invite: TeamInvite; token: string }> {
  const exists = await tx.query('select 1 from teams where id = $1', [teamId]);
  if (exists.rows.length === 0) throw new RowNotFoundError('Team', teamId);

  // Revoke-then-insert rather than upsert. The schema has no unique constraint
  // on team_id, and adding one would need a migration against a database that
  // is already live; more importantly, keeping the superseded row preserves the
  // history of which tokens were ever issued, which an upsert would erase.
  await tx.query(
    'update team_invites set revoked_at = now() where team_id = $1 and revoked_at is null',
    [teamId],
  );

  const generated = generateInviteToken();
  const { rows } = await tx.query(
    `insert into team_invites (team_id, token_hash, token_prefix)
     values ($1, $2, $3)
     returning *`,
    [teamId, generated.tokenHash, generated.tokenPrefix],
  );

  return { invite: mapRow<TeamInvite>(rows[0] as Record<string, unknown>), token: generated.token };
}

interface GroupOutcome {
  created: boolean;
  added: number;
  updated: number;
  unchanged: number;
  linkSet: boolean;
  departed: LearnerAllocationResult['departed'];
}

/**
 * Import one group.
 *
 * Matching is by group number within the cohort, and by email within the team.
 * Email is the only stable identity a spreadsheet offers: names are re-typed,
 * re-spelled and re-ordered between versions of the same sheet, so matching on
 * a name would create a second member every time somebody fixed a typo.
 */
async function importGroup(
  tx: SqlClient,
  cohortId: string,
  group: LearnerAllocationGroup,
): Promise<GroupOutcome> {
  // Read the link before writing it. `returning` after `on conflict do update`
  // reports the NEW row, so it cannot answer "did this change" — the value it
  // would be compared against is the one just written.
  const prior = await tx.query<{ whatsapp_link: string | null }>(
    'select whatsapp_link from teams where cohort_id = $1 and group_number = $2',
    [cohortId, group.groupNumber],
  );
  const priorLink = prior.rows[0]?.whatsapp_link ?? null;

  // A team without a lead is normal here: the allocation sheet designates none.
  // `on conflict` makes re-import idempotent, and `coalesce` on the link means
  // a later sheet with a blank Link column does not erase a link already set.
  const upserted = await tx.query<{ id: string; created: boolean }>(
    `insert into teams (cohort_id, group_number, lead_phone, whatsapp_link)
     values ($1, $2, '', $3)
     on conflict (cohort_id, group_number) do update
        set whatsapp_link = coalesce(excluded.whatsapp_link, teams.whatsapp_link),
            updated_at = now()
     returning id, (xmax = 0) as created`,
    [cohortId, group.groupNumber, group.whatsappLink],
  );
  const row = upserted.rows[0];
  if (!row) throw new Error(`Group ${group.groupNumber} could not be created.`);
  const teamId = row.id;
  const linkSet = group.whatsappLink !== null && group.whatsappLink !== priorLink;

  const existing = await tx.query<{ id: string; full_name: string; email: string | null }>(
    'select id, full_name, email from team_members where team_id = $1',
    [teamId],
  );
  const byEmail = new Map(
    existing.rows
      .filter((m) => m.email !== null)
      .map((m) => [m.email!.toLowerCase(), m] as const),
  );

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let order = existing.rows.length;

  for (const learner of group.learners) {
    const key = learner.email.toLowerCase();
    const match = byEmail.get(key);

    if (!match) {
      await tx.query(
        `insert into team_members (team_id, full_name, email, display_order)
         values ($1, $2, $3, $4)`,
        [teamId, learner.name, learner.email, order],
      );
      order += 1;
      added += 1;
      continue;
    }

    if (match.full_name !== learner.name) {
      // The sheet is the source of truth for spelling. Re-activating is
      // deliberate: a learner reappearing in the sheet has returned.
      await tx.query('update team_members set full_name = $2, is_active = true where id = $1', [
        match.id,
        learner.name,
      ]);
      updated += 1;
    } else {
      unchanged += 1;
    }
    byEmail.delete(key);
  }

  // Whatever is left was in the system but not in this sheet.
  const departed = [...byEmail.values()].map((m) => ({
    teamId,
    groupNumber: group.groupNumber,
    name: m.full_name,
    email: m.email ?? '',
  }));

  return { created: row.created, added, updated, unchanged, linkSet, departed };
}
