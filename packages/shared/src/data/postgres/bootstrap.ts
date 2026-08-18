/**
 * Production bootstrap.
 *
 * Puts in place the things a real deployment cannot function without and that
 * nobody should have to create by hand: the one shared admin account, the
 * rubric, and the approved idea catalogue.
 *
 * Every step is idempotent, because this runs on every start. Two web instances
 * booting at once, or a restart mid-hackathon, must not produce a second admin,
 * duplicate rubric categories, or a reset password.
 *
 * It creates NO cohort, NO team, NO submission, NO score and NO ranking. Real
 * cohorts are created through the admin UI and real teams are imported from a
 * CSV — synthetic rows on a production database eventually get mistaken for
 * genuine ones.
 */

import type { SqlDatabase } from './client';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';
import { IDEA_SEEDS } from '../../fixtures/ideas';
import { hashPassword } from '../../security/password';
import { json } from './rows';

export interface BootstrapInput {
  adminUsername: string;
  adminPassword: string;
  /** Version string for the rubric, e.g. `rubric-v1`. */
  rubricVersion?: string;
}

export interface BootstrapReport {
  adminCreated: boolean;
  rubricCreated: boolean;
  rubricCategories: number;
  ideasCreated: number;
  settingsCreated: number;
  /** True when everything was already in place. */
  alreadyBootstrapped: boolean;
}

/** Settings the application reads and that have no sensible implicit default. */
const REQUIRED_SETTINGS: { key: string; value: unknown; description: string }[] = [
  {
    key: 'judging.enabled',
    value: false,
    description:
      'Whether automated judging may be started. Stays false until the assessment worker is deployed and its production gate is met.',
  },
  {
    key: 'participants.results_visible',
    value: false,
    description:
      'Never true. Assessment results are internal to Outskill and are not shared with participants (ADR-011).',
  },
  {
    key: 'retention.credentials_destroyed_at_finalisation',
    value: true,
    description: 'Destroy stored demo credentials when a cohort is finalised.',
  },
];

export async function bootstrapProduction(
  db: SqlDatabase,
  input: BootstrapInput,
): Promise<BootstrapReport> {
  const rubricVersion = input.rubricVersion ?? RUBRIC_VERSION;

  const report: BootstrapReport = {
    adminCreated: false,
    rubricCreated: false,
    rubricCategories: 0,
    ideasCreated: 0,
    settingsCreated: 0,
    alreadyBootstrapped: false,
  };

  // --- Admin account -------------------------------------------------------
  // Hashed outside the transaction: Argon2id is deliberately slow and there is
  // no reason to hold a connection across it.
  const existingAdmin = await db.query('select 1 from admin_account limit 1');
  if (existingAdmin.rows.length === 0) {
    const passwordHash = await hashPassword(input.adminPassword);
    const inserted = await db.query(
      `insert into admin_account (username, password_hash, password_updated_at)
       values ($1, $2, now())
       on conflict (singleton) do nothing
       returning id`,
      [input.adminUsername, passwordHash],
    );
    report.adminCreated = inserted.rows.length > 0;
  }

  // --- Rubric --------------------------------------------------------------
  await db.transaction(async (tx) => {
    const existing = await tx.query('select id from rubric_versions where version = $1', [
      rubricVersion,
    ]);

    let rubricId: string;
    if (existing.rows.length > 0) {
      rubricId = (existing.rows[0] as { id: string }).id;
    } else {
      const created = await tx.query(
        `insert into rubric_versions (version, name, is_active, notes)
         values ($1, $2, true, $3)
         returning id`,
        [rubricVersion, 'Outskill hackathon rubric', 'Created by production bootstrap.'],
      );
      rubricId = (created.rows[0] as { id: string }).id;
      report.rubricCreated = true;
    }

    // The categories must total exactly 100; `0001` has a trigger that refuses
    // any other total, so a mistake here fails at insert rather than at judging.
    for (const category of RUBRIC_CATEGORIES) {
      const inserted = await tx.query(
        `insert into rubric_categories
           (rubric_version_id, key, title, description, max_points, display_order)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (rubric_version_id, key) do nothing
         returning id`,
        [
          rubricId,
          category.key,
          category.title,
          category.publicDescription,
          category.maxPoints,
          category.displayOrder,
        ],
      );
      if (inserted.rows.length > 0) report.rubricCategories += 1;
    }
  });

  // --- System settings -----------------------------------------------------
  for (const setting of REQUIRED_SETTINGS) {
    // `do nothing`, not `do update`: an operator who has changed a setting must
    // not have it reset by the next deploy.
    const inserted = await db.query(
      `insert into system_settings (key, value, description, updated_by)
       values ($1, $2, $3, 'bootstrap')
       on conflict (key) do nothing
       returning key`,
      [setting.key, json(setting.value), setting.description],
    );
    if (inserted.rows.length > 0) report.settingsCreated += 1;
  }

  report.alreadyBootstrapped =
    !report.adminCreated &&
    !report.rubricCreated &&
    report.rubricCategories === 0 &&
    report.settingsCreated === 0;

  return report;
}

/**
 * Copy the approved idea catalogue into a cohort.
 *
 * Separate from `bootstrapProduction` because ideas belong to a cohort, and a
 * cohort is created by a person through the admin UI. Called when a cohort is
 * created with nothing to clone from.
 *
 * Every definition arrives as a DRAFT. The title and description come from the
 * approved catalogue, but the expanded judging fields are Outskill's
 * interpretation and must be read by a human before they judge anyone (ADR-025).
 */
export async function seedIdeaCatalogue(db: SqlDatabase, cohortId: string): Promise<number> {
  let created = 0;
  for (const seed of IDEA_SEEDS) {
    const inserted = await db.query(
      `insert into cohort_ideas
         (cohort_id, title, slug, description, target_user, expected_use_case,
          minimum_core_flow, expected_entities, ai_opportunity, allowed_scope,
          unsafe_interpretations, display_order, is_active,
          definition_status, definition_approved_at, definition_approved_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'draft',null,null)
       on conflict (cohort_id, slug) do nothing
       returning id`,
      [
        cohortId,
        seed.title,
        seed.slug,
        seed.description,
        seed.targetUser,
        seed.expectedUseCase,
        json(seed.minimumCoreFlow),
        seed.expectedEntities,
        seed.aiOpportunity,
        seed.allowedScope,
        seed.unsafeInterpretations,
        seed.displayOrder,
      ],
    );
    if (inserted.rows.length > 0) created += 1;
  }
  return created;
}
