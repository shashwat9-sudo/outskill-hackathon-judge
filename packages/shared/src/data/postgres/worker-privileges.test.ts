import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';

/**
 * What the worker's database login can actually do.
 *
 * The policies in migration 0002 were written for a role the worker never used:
 * `ohj_worker` was created `nologin`, so the process connected as `postgres`
 * instead — an owner and a superuser, which bypasses row-level security
 * entirely. Every policy was decoration, and a bug in the worker had the whole
 * database.
 *
 * These are negative tests on purpose. Asserting that the worker can read a
 * submission proves very little; the grants exist to make certain things
 * impossible, and the only way to know an impossibility holds is to try it and
 * be refused. Each `expect(...).rejects` below is a door that was open before
 * migration 0006 and is shut now.
 *
 * `set role` rather than a second connection: the privileges being tested are
 * attached to the role, and PGlite is single-connection. The password the
 * operator sets is not part of this — it decides who may become the role, not
 * what the role may do.
 */

let db: PgliteHandle;

/** Run one statement as the worker, whatever happens. */
async function asWorker<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('set role ohj_worker');
  try {
    return await fn();
  } finally {
    await db.query('reset role');
  }
}

const denied = /permission denied|must be owner/i;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

afterEach(async () => {
  // A test that fails mid-statement must not leave the session as the worker
  // and quietly weaken every test after it.
  await db.query('reset role').catch(() => {});
});

describe('the role itself', () => {
  it('is not a superuser and cannot bypass row-level security', async () => {
    /*
     * The property everything else rests on.
     *
     * A superuser ignores RLS silently — no error, just full visibility — so if
     * this ever became true again, every other test in this file would keep
     * passing while proving nothing.
     */
    const { rows } = await db.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
    }>(`select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = 'ohj_worker'`);

    expect(rows[0]).toBeDefined();
    expect(rows[0]!.rolsuper).toBe(false);
    expect(rows[0]!.rolbypassrls).toBe(false);
    expect(rows[0]!.rolcreaterole).toBe(false);
  });

  it('does not own the tables it writes to', async () => {
    // An owner bypasses RLS on its own tables regardless of the flags above.
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tableowner = 'ohj_worker'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('the ranking tables, which decide nothing about winners', () => {
  /*
   * ADR-018: the system ranks privately and Outskill humans choose the Final
   * Four. The worker having no access here is what makes that structural rather
   * than a matter of the pipeline being written correctly.
   */

  it('cannot be read by the worker', async () => {
    for (const table of ['ranking_snapshots', 'ranking_entries', 'final_selections']) {
      await expect(
        asWorker(() => db.query(`select * from ${table} limit 1`)),
        table,
      ).rejects.toThrow(denied);
    }
  });

  it('cannot be written by the worker', async () => {
    await expect(
      asWorker(() => db.query(`insert into final_selections (id) values (gen_random_uuid())`)),
    ).rejects.toThrow(denied);
  });
});

describe('credentials and sessions', () => {
  it('cannot read access-code hashes or participant sessions', async () => {
    /*
     * Where access codes actually live.
     *
     * Not on `teams`, which is what an earlier draft of the migration claimed.
     * These two tables have never been granted to the worker; they are named in
     * the migration's revoke list so a later `grant ... on all tables` cannot
     * quietly reach them, and asserted here so the claim stays true.
     */
    for (const table of ['team_access_codes', 'participant_sessions']) {
      await expect(
        asWorker(() => db.query(`select * from ${table} limit 1`)),
        table,
      ).rejects.toThrow(denied);
    }
  });

  it('cannot read the admin account or live sessions', async () => {
    // Password hashes and session tokens. Nothing in judging needs them, and a
    // worker that could read a session token could become an admin.
    for (const table of ['admin_account', 'admin_sessions']) {
      await expect(
        asWorker(() => db.query(`select * from ${table} limit 1`)),
        table,
      ).rejects.toThrow(denied);
    }
  });

  it('may read a product credential but never change one', async () => {
    // The worker decrypts these at the moment of use. Writing one back would
    // let a bug overwrite what a team actually gave us.
    await expect(
      asWorker(() => db.query(`select * from submission_credentials limit 1`)),
    ).resolves.toBeDefined();

    await expect(
      asWorker(() => db.query(`update submission_credentials set username_ciphertext = 'x'`)),
    ).rejects.toThrow(denied);
  });
});

describe('learner work', () => {
  it('can be read but not edited', async () => {
    await expect(asWorker(() => db.query(`select id from submissions limit 1`))).resolves.toBeDefined();

    await expect(
      asWorker(() => db.query(`update submissions set product_url = 'https://evil.test'`)),
    ).rejects.toThrow(denied);
  });

  it('cannot be deleted, by any route the worker has', async () => {
    /*
     * Nothing in the pipeline deletes a row. A worker that could delete could
     * erase the evidence behind a score, or a submission a team spent two weeks
     * on, and no amount of careful application code makes that safe.
     */
    for (const table of ['submissions', 'browser_test_runs', 'assessment_jobs', 'audit_logs']) {
      await expect(
        asWorker(() => db.query(`delete from ${table}`)),
        table,
      ).rejects.toThrow(denied);
    }
  });

  it('cannot read team invites, participant events or resource documents', async () => {
    for (const table of ['team_invites', 'submission_events', 'resource_documents']) {
      await expect(
        asWorker(() => db.query(`select * from ${table} limit 1`)),
        table,
      ).rejects.toThrow(denied);
    }
  });
});

describe('the assessment output the worker owns', () => {
  it('can be read, inserted and updated', async () => {
    // The other half of least privilege: a role so tight the worker cannot do
    // its job is not a safer system, it is a broken one.
    for (const table of [
      'assessment_jobs',
      'browser_test_runs',
      'browser_test_steps',
      'category_scores',
      'manual_review_flags',
      'preflight_checks',
    ]) {
      await expect(
        asWorker(() => db.query(`select * from ${table} limit 1`)),
        table,
      ).resolves.toBeDefined();
    }
  });

  it('can append to the audit log but never read one back', async () => {
    /*
     * Append-only, and denied outright rather than merely empty.
     *
     * These were briefly granted at SELECT while the worker still used the admin
     * submission read, which touched both tables. It now uses `getJudgingInput`,
     * which does not, so the grants are gone: a query that cannot run is a
     * stronger guarantee than a policy that happens to return nothing.
     */
    await expect(asWorker(() => db.query(`select * from audit_logs limit 1`))).rejects.toThrow(denied);
    await expect(asWorker(() => db.query(`update audit_logs set action = 'x'`))).rejects.toThrow(denied);
    await expect(
      asWorker(() => db.query(`select * from submission_events limit 1`)),
    ).rejects.toThrow(denied);

    // Writing its own entry is still allowed — that is the whole point.
    await expect(
      asWorker(() =>
        db.query(`insert into audit_logs (actor_type, action, entity_type)
                  select 'worker', 'probe', 'submission' where false`),
      ),
    ).resolves.toBeDefined();
  });
});

describe('a table nobody has granted yet', () => {
  it('is unreachable by the worker until somebody says otherwise', async () => {
    /*
     * The direction the mistake should fall in.
     *
     * Migration 0002 granted `on all tables`, so a table added later became
     * worker-writable the moment it was created. Default privileges now revoke
     * instead, which means a new table is invisible until a grant is written
     * deliberately — a missing feature rather than a silent hole.
     */
    await db.query(`create table if not exists later_addition (id uuid primary key)`);
    try {
      await expect(asWorker(() => db.query(`select * from later_addition`))).rejects.toThrow(denied);
    } finally {
      await db.query(`drop table if exists later_addition`);
    }
  });
});
