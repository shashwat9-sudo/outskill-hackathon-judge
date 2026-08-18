/**
 * Batch 5 preflight. READ-ONLY.
 *
 * Final submit is irreversible, so every invariant is checked from the real
 * database and the real bucket before anything is written. A failure here stops
 * the run rather than locking a submission that was not ready.
 */
import { readFileSync } from 'node:fs';
import { createPostgresDataStore } from '../packages/shared/src/data/postgres/store';
import { evaluateCompleteness } from '../packages/shared/src/schemas/submission';
import { resolveArtifactsStep } from '../packages/shared/src/domain/artifact-state';

async function main() {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key) process.env[key] ??= (value ?? '').trim();
  }
  const store = await createPostgresDataStore({
    databaseUrl: process.env.DATABASE_URL!,
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!,
    sessionSecret: process.env.ADMIN_SESSION_SECRET!,
    credentialKey: process.env.CREDENTIAL_ENCRYPTION_KEY!,
    credentialKeyVersion: Number(process.env.CREDENTIAL_KEY_VERSION ?? 1),
    maxConnections: 2,
  });

  const checks: [string, boolean, string][] = [];
  const cohort = await store.cohorts.findActiveCohort();
  checks.push(['cohort is open', cohort?.status === 'open', String(cohort?.status)]);

  const list = await store.submissions.listSubmissions(cohort!.id);
  const item = list.find((s) => s.team.groupNumber === 901)!;
  const detail = await store.submissions.getSubmissionDetail(item.submission.id);
  const sub = detail!.submission;

  checks.push(['group 901 is a draft', sub.status === 'draft', sub.status]);
  checks.push(['no receipt yet', !sub.receiptId, sub.receiptId ? 'PRESENT' : 'none']);
  checks.push(['no submitted_at yet', !sub.submittedAt, sub.submittedAt ? 'PRESENT' : 'none']);
  checks.push(['no locked_at yet', !sub.lockedAt, sub.lockedAt ? 'PRESENT' : 'none']);

  const decks = detail!.artifacts.filter((a) => a.kind === 'deck_pdf');
  const videos = detail!.artifacts.filter((a) => a.kind === 'demo_video');
  checks.push(['exactly one deck artifact', decks.length === 1, String(decks.length)]);
  checks.push(['demo video artifact present', videos.length === 1, String(videos.length)]);

  let objectOk = false;
  let objectDetail = 'not checked';
  if (decks[0]) {
    try {
      const url = await store.resources.getSignedUrl(decks[0].storageBucket!, decks[0].storagePath!, 60);
      const res = await fetch(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      objectOk =
        res.ok &&
        bytes.byteLength === decks[0].byteSize &&
        new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
      objectDetail = `HTTP ${res.status}, ${bytes.byteLength} bytes`;
    } catch (e) {
      objectDetail = (e as Error).message;
    }
  }
  checks.push(['deck object in private Storage', objectOk, objectDetail]);

  const rawPayload = (sub as unknown as { draftPayload?: unknown }).draftPayload;
  const payload = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload ?? {})) as Record<string, unknown>;
  checks.push([
    'draft payload has every step',
    ['team', 'product', 'live', 'artifacts', 'learning', 'declarations'].every((k) => k in payload),
    Object.keys(payload).sort().join(', ') || '(none)',
  ]);

  // --- the specific values the operator re-attested by hand ---
  const artifactsStep = (payload.artifacts ?? {}) as Record<string, unknown>;
  const declarationsStep = (payload.declarations ?? {}) as Record<string, unknown>;
  const teamStep = (payload.team ?? {}) as Record<string, unknown>;

  checks.push([
    'demoUnderThreeMinutes is true',
    artifactsStep.demoUnderThreeMinutes === true,
    String(artifactsStep.demoUnderThreeMinutes),
  ]);

  const declarationValues = Object.values(declarationsStep);
  const declarationsAllTrue =
    declarationValues.length > 0 && declarationValues.every((v) => v === true);
  checks.push([
    'every declaration is confirmed',
    declarationsAllTrue,
    `${declarationValues.filter((v) => v === true).length}/${declarationValues.length} true`,
  ]);

  checks.push([
    'team step holds lead data',
    Boolean(teamStep.leadName) || Boolean(teamStep.groupNumber),
    Object.keys(teamStep).join(', ') || '(empty)',
  ]);

  const members = teamStep.members;
  checks.push([
    'team member data persisted',
    Array.isArray(members) ? members.length > 0 : Boolean(members),
    Array.isArray(members) ? `${members.length} member(s)` : String(members),
  ]);

  // --- promoted columns still intact ---
  const columnsIntact =
    Boolean(sub.productName) &&
    Boolean(sub.productUrl) &&
    Boolean(sub.mustHaveWorkflow) &&
    Boolean(sub.mostImportantLearning);
  checks.push([
    'product/live/learning columns intact',
    columnsIntact,
    columnsIntact ? 'all present' : 'one or more empty',
  ]);

  // --- version moved on from the stale save ---
  checks.push([
    'version is newer than the stale 77',
    sub.version > 77,
    `v${sub.version}`,
  ]);

  const draftUpdated = (sub as unknown as { draftUpdatedAt?: Date | string }).draftUpdatedAt;
  const updatedAt = draftUpdated ? new Date(draftUpdated) : null;
  const ageMinutes = updatedAt ? (Date.now() - updatedAt.getTime()) / 60_000 : Number.NaN;
  checks.push([
    'draft was saved recently',
    Number.isFinite(ageMinutes) && ageMinutes < 90,
    Number.isFinite(ageMinutes) ? `${Math.round(ageMinutes)} min ago` : 'unknown',
  ]);

  const merged = {
    ...payload,
    artifacts: resolveArtifactsStep(payload.artifacts as never, detail!.artifacts),
  };
  const completeness = evaluateCompleteness(merged);
  const failing = completeness.steps.filter((s) => !s.complete);
  checks.push([
    'all learner sections complete',
    completeness.complete,
    completeness.complete
      ? 'complete'
      : failing.map((s) => `${s.label}: ${s.issues.map((i) => i.message).join('; ')}`).join(' | ').slice(0, 220),
  ]);

  console.log('BATCH 5 PREFLIGHT');
  let allOk = true;
  for (const [name, ok, detailText] of checks) {
    if (!ok) allOk = false;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(32)} ${detailText}`);
  }
  console.log(`\nVERDICT: ${allOk ? 'SAFE TO PROCEED' : 'STOP — invariant failed'}`);
  process.exitCode = allOk ? 0 : 1;
}
main();
