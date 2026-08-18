/**
 * Fill one synthetic staging team's draft, so the browser can test final submit.
 *
 * Not a shortcut around the form: typing a whole submission through a browser
 * would test the typing, and what needs testing on a deployment is the lock and
 * the receipt. Everything here is obviously synthetic, and it only ever touches
 * the STAGING cohort — the guard refuses to look anywhere else.
 *
 *   npx tsx scripts/fill-staging-draft.ts
 */

import { readFileSync } from 'node:fs';
import { createPostgresDatabase } from '../packages/shared/src/data/postgres/client';
import { buildParticipantStore } from '../packages/shared/src/data/postgres/repositories/participant';
import { createSupabaseStorage } from '../packages/shared/src/data/postgres/storage';

const GROUP = 812;
const COHORT_PREFIX = 'STAGING SMOKE TEST';
const DECK = '/tmp/staging-deck.pdf';

function loadEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match || !match[2]) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    env[match[1] as string] = value;
  }
  return env;
}

/** Answers about a product that does not exist, written the way the form asks. */
const DRAFT = {
  team: {
    groupNumber: GROUP,
    leadName: 'Ada Synthetic 812',
    leadEmail: 'ada.812@example.com',
    leadPhone: '+91 90000 00812',
    members: [
      { fullName: 'Ada Synthetic 812', contribution: 'Built the goal screen and the progress form.', isActive: true },
      { fullName: 'Ben Synthetic 812', contribution: 'Set up the database and the login screen.', isActive: true },
    ],
  },
  product: {
    // ideaId is filled in at run time — the ids belong to the cohort, and a
    // submission without one is refused: a team may only build from the ideas
    // approved for its own cohort.
    ideaId: '',
    productName: 'Staging Smoke Tracker',
    primaryUser: 'People who want a simple way to track their fitness goals.',
    exactProblem: 'People set fitness goals but often lose track of their daily progress.',
    oneSentencePromise: 'For people with goals, we built a tracker so they can see progress daily.',
    briefDescription:
      'Users create a fitness goal, add progress as they go, and see how close they are to finishing it.',
    whyAiNecessary: "AI looks at the user's progress and gives simple suggestions on what to do next.",
    differentiation: 'Most trackers only show numbers. Ours explains what the numbers mean.',
    mustHaveWorkflow: 'Create a goal, add progress, check how far along they are, and complete it.',
    shouldHaveFeatures: [],
    excludedFeatures: 'We skipped reminders so the tracking itself worked properly.',
  },
  live: {
    productUrl: 'https://staging-smoke-tracker.example.com',
    loginRequired: false,
    coreTestSteps: [
      { action: 'Click "Add a goal".', expectedResult: 'A form opens asking for the goal name.' },
      { action: 'Save the goal.', expectedResult: 'The goal appears in the list straight away.' },
    ],
    safeSampleInputs: 'Goal name: Walk 10,000 steps a day. Target: 30 days.',
    resetInstructions: 'Open the goal and press Delete. Nothing else is saved.',
    knownLimitations: 'The mobile design still needs some polish.',
  },
  artifacts: {
    demoVideoUrl: 'https://www.loom.com/share/00000000000000000000000000000812',
    demoUnderThreeMinutes: true,
  },
  learning: {
    bugsFixed: [
      { description: 'New goals were not showing immediately after saving.', howFixed: 'We refreshed the list after saving.' },
      { description: 'The progress bar went past 100% when someone logged extra.', howFixed: 'We capped the bar at 100%.' },
      { description: 'On a phone the Save button hid behind the keyboard.', howFixed: 'We moved the button above the keyboard.' },
    ],
    deliberatelyExcluded: 'We left out weekly email summaries because daily tracking mattered more.',
    majorTradeoff: 'We spent our time on the progress screen instead of the visual design.',
    day12ToDay13Changes: 'On Day 13 we fixed the saving bug and added the progress bar.',
    mostImportantLearning: 'A smaller workflow that works properly beats several unfinished ones.',
    nextSevenDayPlan: 'Improve the mobile design and add better progress charts.',
    builderStack: 'Synthetic stack, for staging only',
    apisUsed: '',
    externalTemplates: '',
  },
  // Declarations are deliberately absent. They are the learner's own act, and
  // the browser test ticks them itself — writing them here would be this script
  // agreeing to something on a team's behalf, which is the one thing the whole
  // declarations design exists to prevent.
};

async function main() {
  const env = loadEnvFile('.env.local');
  const db = await createPostgresDatabase({ connectionString: env.DATABASE_URL!, maxConnections: 2 });

  try {
    const { rows: cohorts } = await db.query<{ id: string; name: string }>(
      'select id, name from cohorts where name like $1',
      [`${COHORT_PREFIX}%`],
    );
    const cohort = cohorts[0];
    if (!cohort) throw new Error(`no cohort starting "${COHORT_PREFIX}" — nothing to fill`);

    const { rows: teams } = await db.query<{ id: string }>(
      'select id from teams where cohort_id = $1 and group_number = $2',
      [cohort.id, GROUP],
    );
    const team = teams[0];
    if (!team) throw new Error(`group ${GROUP} not found in ${cohort.name}`);

    const storage = await createSupabaseStorage({
      url: env.SUPABASE_URL!,
      serviceRoleKey: env.SUPABASE_SECRET_KEY!,
    });

    const participant = buildParticipantStore({
      db,
      storage,
      sessionSecret: env.ADMIN_SESSION_SECRET!,
      credentialKey: env.CREDENTIAL_ENCRYPTION_KEY!,
      credentialKeyVersion: Number(env.CREDENTIAL_KEY_VERSION ?? 1),
    });

    const session = await participant.createSession({
      teamId: team.id,
      editorName: 'Staging Fixture',
      editorRole: null,
      ipHash: null,
    });

    const view = await participant.resolveSession(session.token);
    if (!view) throw new Error('session did not resolve');

    const idea = view.ideas[0];
    if (!idea) throw new Error('the cohort has no active ideas — nothing a team could choose');
    const draft = { ...DRAFT, product: { ...DRAFT.product, ideaId: idea.id } };
    console.log(`  · chose approved idea: ${idea.title}`);

    const saved = await participant.saveDraft(session.token, draft, view.submission.version);
    if (!saved.ok) throw new Error(`saveDraft refused: ${JSON.stringify(saved)}`);
    console.log('  ✅ draft written (declarations deliberately left unticked)');

    const already = view.artifacts.find((a) => a.kind === 'deck_pdf');
    if (already) {
      console.log('  · deck already present, left as it is');
    } else {
      const bytes = readFileSync(DECK);
      const uploaded = await participant.uploadDeck(session.token, {
        bytes: new Uint8Array(bytes),
        originalFilename: 'staging-deck.pdf',
        mimeType: 'application/pdf',
      });
      console.log(uploaded ? '  ✅ deck uploaded' : '  ✗ deck upload refused');
    }

    /*
     * The demo video is an artifact row, not a draft field.
     *
     * `resolveArtifactsStep` makes artifact rows authoritative over the draft
     * payload — the F-8 fix, after a payload's empty strings shadowed real
     * uploads. So writing `demoVideoUrl` into the draft above does nothing on
     * its own, and the step stays incomplete until this row exists.
     */
    const reloaded = await participant.resolveSession(session.token);
    if (!reloaded?.artifacts.some((a) => a.kind === 'demo_video')) {
      const video = await participant.attachArtifact(session.token, {
        kind: 'demo_video',
        storageBucket: null,
        storagePath: null,
        originalFilename: null,
        mimeType: null,
        byteSize: null,
        checksumSha256: null,
        externalUrl: 'https://www.loom.com/share/00000000000000000000000000000812',
        uploadCompletedAt: new Date(),
        isAccessible: true,
        lastCheckedAt: new Date(),
      });
      console.log(video ? '  ✅ demo video linked' : '  ✗ demo video refused');
    } else {
      console.log('  · demo video already linked');
    }

    const after = await participant.resolveSession(session.token);
    const complete = after?.submission.status;
    console.log(`  · submission status: ${complete}`);
    console.log(`  · artifacts: ${after?.artifacts.map((a) => a.kind).join(', ') || 'none'}`);
  } finally {
    await db.close();
  }
}

void main().catch((error) => {
  console.error(`\n  ❌ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
