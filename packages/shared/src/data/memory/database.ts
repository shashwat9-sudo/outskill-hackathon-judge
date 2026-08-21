/**
 * In-memory database for demo mode.
 *
 * Holds the same entities the postgres driver does, seeded deterministically
 * from the fixtures so a demo is identical on every run.
 *
 * Deliberately simple: plain arrays with linear scans. At six submissions there
 * is nothing to optimise, and the postgres driver is where indexes belong.
 */

import { RUBRIC_CATEGORIES, RUBRIC_VERSION, totalScore } from '../../rubric/index';
import { generateInviteToken, encryptSecret, serialiseEnvelope } from '../../security/crypto';
import { compareForRanking, type RankableSubmission } from '../../domain/ranking';
import type {
  AdminAccount,
  AdminSession,
  ArtifactAnalysis,
  AssessmentEvidence,
  AssessmentJob,
  AssessmentSummary,
  AuditLog,
  BrowserTestRun,
  BrowserTestStep,
  CategoryScore,
  Cohort,
  CohortIdea,
  ConsistencyReview,
  Disqualification,
  FeedbackReport,
  FinalSelection,
  ManualReviewFlag,
  PreflightCheck,
  RankingEntry,
  RankingSnapshot,
  ResourceDocument,
  Submission,
  SubmissionArtifact,
  SubmissionCredentials,
  SubmissionDeclarations,
  SubmissionEvent,
  ParticipantSession,
  SystemSetting,
  Team,
  TeamAccessCode,
  TeamActivity,
  TeamInvite,
  TeamMember,
  VerificationAttempt,
  TestPlan,
  TestPlanStep,
} from '../types';
import { IDEA_SEEDS } from '../../fixtures/ideas';
import {
  buildDemoPreflight,
  buildDemoScores,
  DEMO_ASSESSMENT_CONFIG,
  DEMO_BROWSER_RUNS,
  DEMO_COHORT,
  hoursAgo,
  DEMO_FEEDBACK,
  DEMO_MODEL_VERSION,
  DEMO_NOW,
  DEMO_PROMPT_VERSION,
  DEMO_TEAMS,
  demoEmail,
  demoJobId,
  demoPhone,
  demoProductUrl,
  demoReceiptId,
  demoSubmissionId,
  demoTeamId,
  id,
  type DemoScenario,
} from '../../fixtures/demo';

export interface MemoryDatabase {
  adminAccount: AdminAccount | null;
  adminSessions: AdminSession[];
  cohorts: Cohort[];
  ideas: CohortIdea[];
  teams: Team[];
  teamMembers: TeamMember[];
  teamInvites: TeamInvite[];
  /** Demo-only: plaintext invite tokens, so the demo can print working links. */
  demoInviteTokens: Map<string, string>;
  accessCodes: TeamAccessCode[];
  participantSessions: ParticipantSession[];
  teamActivity: TeamActivity[];
  verificationAttempts: VerificationAttempt[];
  submissions: Submission[];
  artifacts: SubmissionArtifact[];
  credentials: SubmissionCredentials[];
  declarations: SubmissionDeclarations[];
  events: SubmissionEvent[];
  jobs: AssessmentJob[];
  preflight: PreflightCheck[];
  artifactAnalyses: ArtifactAnalysis[];
  testPlans: TestPlan[];
  testPlanSteps: TestPlanStep[];
  browserRuns: BrowserTestRun[];
  browserSteps: BrowserTestStep[];
  evidence: AssessmentEvidence[];
  scores: CategoryScore[];
  summaries: AssessmentSummary[];
  consistencyReviews: ConsistencyReview[];
  manualReviewFlags: ManualReviewFlag[];
  disqualifications: Disqualification[];
  rankingSnapshots: RankingSnapshot[];
  rankingEntries: RankingEntry[];
  finalSelections: FinalSelection[];
  feedbackReports: FeedbackReport[];
  resources: ResourceDocument[];
  auditLogs: AuditLog[];
  settings: SystemSetting[];
}

export function createEmptyDatabase(): MemoryDatabase {
  return {
    adminAccount: null,
    adminSessions: [],
    cohorts: [],
    ideas: [],
    teams: [],
    teamMembers: [],
    teamInvites: [],
    demoInviteTokens: new Map(),
    accessCodes: [],
    participantSessions: [],
    teamActivity: [],
    verificationAttempts: [],
    submissions: [],
    artifacts: [],
    credentials: [],
    declarations: [],
    events: [],
    jobs: [],
    preflight: [],
    artifactAnalyses: [],
    testPlans: [],
    testPlanSteps: [],
    browserRuns: [],
    browserSteps: [],
    evidence: [],
    scores: [],
    summaries: [],
    consistencyReviews: [],
    manualReviewFlags: [],
    disqualifications: [],
    rankingSnapshots: [],
    rankingEntries: [],
    finalSelections: [],
    feedbackReports: [],
    resources: [],
    auditLogs: [],
    settings: [],
  };
}

/** Demo-mode encryption key. Never used outside demo mode. */
const DEMO_KEY = Buffer.alloc(32, 7);

const SCENARIOS_WITH_JOBS: DemoScenario[] = [
  'complete',
  'inaccessible',
  'login_required',
  'manual_review',
  'low_confidence',
];

const SCENARIOS_WITH_SCORES: DemoScenario[] = ['complete', 'login_required', 'low_confidence'];

/**
 * Seed the deterministic demo cohort.
 *
 * Order matters: cohort → ideas → teams → submissions → jobs → assessment
 * output → ranking. Ranking is generated from the seeded scores rather than
 * hard-coded, so the fixture exercises the real ranking code.
 */
export function seedDemoDatabase(db: MemoryDatabase): void {
  const cohort: Cohort = {
    ...DEMO_COHORT,
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
    // Demo fixtures are synthetic, and now say so rather than being recognised
    // by which database engine they happen to live in.
    isSynthetic: true,
    externalCohortId: null,
  };
  db.cohorts.push(cohort);

  // Ideas
  IDEA_SEEDS.forEach((seed, index) => {
    db.ideas.push({
      id: id(`idea-${seed.slug}`),
      cohortId: cohort.id,
      title: seed.title,
      slug: seed.slug,
      description: seed.description,
      targetUser: seed.targetUser,
      expectedUseCase: seed.expectedUseCase,
      minimumCoreFlow: [...seed.minimumCoreFlow],
      expectedEntities: [...seed.expectedEntities],
      aiOpportunity: seed.aiOpportunity,
      allowedScope: seed.allowedScope,
      unsafeInterpretations: seed.unsafeInterpretations,
      displayOrder: seed.displayOrder,
      isActive: true,
      // Most seeded definitions ship approved so the demo pipeline is complete.
      // The first stays in draft on purpose: an operator who never sees that
      // state will not know to look for it on a real cohort, where every
      // expanded definition starts unapproved (ADR-025).
      definitionStatus: index === 0 ? 'draft' : 'approved',
      definitionApprovedAt: index === 0 ? null : DEMO_COHORT.createdAt,
      definitionApprovedBy: index === 0 ? null : 'demo-fixture',
      createdAt: DEMO_COHORT.createdAt,
      updatedAt: DEMO_COHORT.createdAt,
    });
  });

  // Resource library — what an operator and a participant actually need.
  const resource = (
    key: string,
    kind: ResourceDocument['kind'],
    title: string,
    description: string,
    storagePath: string,
    mimeType: string,
    byteSize: number,
    isParticipantVisible: boolean,
    displayOrder: number,
  ): ResourceDocument => ({
    id: id(`resource-${key}`),
    cohortId: cohort.id,
    kind,
    title,
    description,
    storageBucket: 'admin-resources',
    storagePath,
    mimeType,
    byteSize,
    isParticipantVisible,
    displayOrder,
    createdAt: DEMO_COHORT.createdAt,
  });

  db.resources.push(
    // Participant-visible.
    resource(
      'pitch-template',
      'pitch_template',
      'Official pitch-deck template',
      'The template to build your pitch deck from. Export as PDF before submitting.',
      'templates/pitch-deck-template.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      8_343_316,
      true,
      1,
    ),
    resource(
      'instructions',
      'instructions',
      'Submission instructions',
      'What to prepare before you submit, and what happens after the deadline.',
      'docs/submission-instructions.pdf',
      'application/pdf',
      128_400,
      true,
      2,
    ),
    resource(
      'idea-guide',
      'other',
      'Approved product-idea guide',
      'The eight approved challenges, with the minimum core flow expected for each.',
      'docs/approved-ideas.pdf',
      'application/pdf',
      96_200,
      true,
      3,
    ),
    resource(
      'workbook',
      'playbook',
      'Product-building workbook',
      'The ideation, build and demo workbook used through the accelerator.',
      'docs/product-building-workbook.pdf',
      'application/pdf',
      706_532,
      true,
      4,
    ),
    // Internal.
    resource(
      'admin-playbook',
      'playbook',
      'Admin operating playbook',
      'How to run a cohort end to end, including the Day 13 to Day 14 checklist.',
      'docs/ADMIN_PLAYBOOK.md',
      'text/markdown',
      21_400,
      false,
      5,
    ),
    resource(
      'internal-deck',
      'other',
      'Internal product demo deck',
      'Eleven-slide briefing on what the platform does and how judging works.',
      'docs/deck/internal-briefing.html',
      'text/html',
      11_553,
      false,
      6,
    ),
    resource(
      'deployment-runbook',
      'other',
      'Deployment runbook',
      'What a production deployment involves, including the worker egress policy.',
      'docs/DEPLOYMENT_RUNBOOK.md',
      'text/markdown',
      9_800,
      false,
      7,
    ),
    resource(
      'night-checklist',
      'other',
      'Day 13 to Day 14 checklist',
      'The ten-hour run from deadline to private shortlist, hour by hour.',
      'docs/ADMIN_PLAYBOOK.md',
      'text/markdown',
      21_400,
      false,
      8,
    ),
    resource(
      'rubric-guide',
      'other',
      'Scoring-rubric guide',
      'The eight categories, their weights, and what evidence supports each.',
      'docs/PRD.md',
      'text/markdown',
      14_200,
      false,
      9,
    ),
  );

  // Teams, submissions, and everything downstream
  for (const seed of DEMO_TEAMS) {
    const teamId = demoTeamId(seed.groupNumber);
    const submissionId = demoSubmissionId(seed.groupNumber);
    const idea = db.ideas.find((i) => i.slug === seed.ideaSlug);
    if (!idea) throw new Error(`Demo fixture references unknown idea slug: ${seed.ideaSlug}`);

    db.teams.push({
      id: teamId,
      cohortId: cohort.id,
      groupNumber: seed.groupNumber,
      leadName: `Group ${seed.groupNumber} Lead (Demo)`,
      leadEmail: demoEmail(seed.groupNumber),
      leadPhone: demoPhone(seed.groupNumber),
      whatsappLink: null,
      status: 'active',
      importedAt: DEMO_COHORT.createdAt,
      createdAt: DEMO_COHORT.createdAt,
      updatedAt: DEMO_COHORT.createdAt,
    });

    seed.memberRoles.forEach((role, index) => {
      db.teamMembers.push({
        id: id(`member-${seed.groupNumber}-${index}`),
        teamId,
        fullName: `${role} · Group ${seed.groupNumber}`,
        email: null,
        contribution: MEMBER_CONTRIBUTIONS[index % MEMBER_CONTRIBUTIONS.length] as string,
        displayOrder: index,
        isActive: true,
      });
    });

    // Invite (demo keeps the plaintext token so links can be printed)
    const invite = generateInviteToken();
    db.teamInvites.push({
      id: id(`invite-${seed.groupNumber}`),
      teamId,
      tokenHash: invite.tokenHash,
      tokenPrefix: invite.tokenPrefix,
      issuedAt: DEMO_COHORT.createdAt,
      expiresAt: null,
      revokedAt: null,
      lastAccessedAt: null,
      accessCount: 0,
    });
    db.demoInviteTokens.set(teamId, invite.token);

    const isIncomplete = seed.scenario === 'incomplete';
    const submittedAt = isIncomplete ? null : hoursAgo(5);

    db.submissions.push(
      buildSubmission({
        submissionId,
        cohortId: cohort.id,
        teamId,
        ideaId: idea.id,
        seedScenario: seed.scenario,
        productName: seed.productName,
        ideaSlug: seed.ideaSlug,
        groupNumber: seed.groupNumber,
        submittedAt,
      }),
    );

    // Artifacts
    if (!isIncomplete) {
      db.artifacts.push({
        id: id(`artifact-deck-${seed.groupNumber}`),
        submissionId,
        kind: 'deck_pdf',
        storageBucket: 'submission-decks',
        storagePath: `${cohort.id}/${submissionId}/pitch-deck.pdf`,
        originalFilename: 'pitch-deck.pdf',
        mimeType: 'application/pdf',
        byteSize: 1_240_000 + seed.groupNumber * 1000,
        checksumSha256: id(`checksum-${seed.groupNumber}`).replace(/-/g, ''),
        externalUrl: null,
        uploadCompletedAt: submittedAt,
        isAccessible: true,
        lastCheckedAt: DEMO_NOW,
        createdAt: submittedAt ?? DEMO_NOW,
      });
      db.artifacts.push({
        id: id(`artifact-demo-${seed.groupNumber}`),
        submissionId,
        kind: 'demo_video',
        storageBucket: null,
        storagePath: null,
        originalFilename: null,
        mimeType: null,
        byteSize: null,
        checksumSha256: null,
        externalUrl: `https://www.loom.com/share/demo-group-${seed.groupNumber}`,
        uploadCompletedAt: submittedAt,
        isAccessible: seed.scenario !== 'low_confidence',
        lastCheckedAt: DEMO_NOW,
        createdAt: submittedAt ?? DEMO_NOW,
      });
    }

    // Declarations
    db.declarations.push({
      id: id(`declarations-${seed.groupNumber}`),
      submissionId,
      builtDuringHackathon: !isIncomplete,
      ownedByTeam: !isIncomplete,
      externalMaterialDisclosed: !isIncomplete,
      judgeMayModifyDemoData: !isIncomplete,
      noRealCustomerData: !isIncomplete,
      urlsAvailableThroughJudging: !isIncomplete,
      permissionToSubmit: !isIncomplete,
      acceptedAt: submittedAt,
      acceptedIpHash: submittedAt ? id(`iphash-${seed.groupNumber}`).slice(0, 32) : null,
    });

    // Credentials (login-required scenario only)
    if (seed.scenario === 'login_required') {
      db.credentials.push({
        id: id(`credentials-${seed.groupNumber}`),
        submissionId,
        usernameCiphertext: serialiseEnvelope(encryptSecret('demo.reviewer@demo.invalid', DEMO_KEY)),
        passwordCiphertext: serialiseEnvelope(encryptSecret('DemoReviewer!2026', DEMO_KEY)),
        loginInstructionsCiphertext: serialiseEnvelope(
          encryptSecret('Use the "Sign in" button on the landing page. The account has sample notes already.', DEMO_KEY),
        ),
        keyVersion: 1,
        deletedAt: null,
        lastRevealedAt: null,
        createdAt: submittedAt ?? DEMO_NOW,
        updatedAt: submittedAt ?? DEMO_NOW,
      });
    }

    // Submission events
    db.events.push({
      id: id(`event-created-${seed.groupNumber}`),
      submissionId,
      eventType: 'draft_created',
      actorType: 'participant',
      detail: {},
      createdAt: hoursAgo(30),
    });
    if (!isIncomplete) {
      db.events.push({
        id: id(`event-submitted-${seed.groupNumber}`),
        submissionId,
        eventType: 'final_submitted',
        actorType: 'participant',
        detail: { receiptId: demoReceiptId(seed.groupNumber) },
        createdAt: submittedAt as Date,
      });
    }

    if (!SCENARIOS_WITH_JOBS.includes(seed.scenario)) continue;

    seedAssessment(db, {
      cohortId: cohort.id,
      submissionId,
      groupNumber: seed.groupNumber,
      scenario: seed.scenario,
    });
  }

  seedRanking(db, cohort);
  seedSettings(db);
}

const MEMBER_CONTRIBUTIONS = [
  'Coordinated the team, owned the product scope and ran the demo.',
  'Built the core screens and the main create-and-edit flow.',
  'Set up the database and wired the backend calls.',
  'Designed the interface and produced the pitch deck.',
];

function buildSubmission(input: {
  submissionId: string;
  cohortId: string;
  teamId: string;
  ideaId: string;
  seedScenario: DemoScenario;
  productName: string;
  ideaSlug: string;
  groupNumber: number;
  submittedAt: Date | null;
}): Submission {
  const incomplete = input.seedScenario === 'incomplete';
  const text = SUBMISSION_TEXT[input.seedScenario];

  return {
    id: input.submissionId,
    cohortId: input.cohortId,
    teamId: input.teamId,
    status: incomplete ? 'draft' : 'locked',
    ideaId: input.ideaId,

    productName: input.productName,
    primaryUser: incomplete ? null : text.primaryUser,
    exactProblem: incomplete ? null : text.exactProblem,
    oneSentencePromise: incomplete ? null : text.promise,
    briefDescription: incomplete ? null : text.description,
    whyAiNecessary: incomplete ? null : text.whyAi,
    differentiation: incomplete ? null : text.differentiation,
    mustHaveWorkflow: incomplete ? null : text.mustHave,
    shouldHaveFeatures: incomplete ? [] : [...text.shouldHave],
    excludedFeatures: incomplete ? null : text.excluded,

    productUrl:
      input.seedScenario === 'manual_review'
        ? `https://apps.example.com/listing/group-${input.groupNumber}`
        : demoProductUrl(input.ideaSlug, input.groupNumber),
    loomUrl: null,
    deckUrl: null,
    loginRequired: input.seedScenario === 'login_required',
    coreTestSteps: incomplete ? [] : text.testSteps.map((s) => ({ ...s })),
    safeSampleInputs: incomplete ? null : text.sampleInputs,
    resetInstructions: incomplete ? null : 'Delete any records prefixed OUTSKILL-JUDGE- from the list view.',
    knownLimitations: incomplete ? null : text.limitations,

    bugsFixed: incomplete ? [] : text.bugs.map((b) => ({ ...b })),
    deliberatelyExcluded: incomplete ? null : text.excluded,
    majorTradeoff: incomplete ? null : text.tradeoff,
    day12ToDay13Changes: incomplete ? null : text.dayChanges,
    whatGotWorking: null,
    mostImportantLearning: incomplete ? null : text.learning,
    nextSevenDayPlan: incomplete ? null : text.nextPlan,
    builderStack: incomplete ? null : 'Bolt for the front end, Supabase for data and auth, an LLM API for the AI feature.',
    apisUsed: incomplete ? null : 'LLM API for suggestions.',
    externalTemplates: incomplete ? null : 'Started from the builder default template; all product logic is ours.',

    version: 1,
    lastEditedBy: incomplete ? 'Builder One (Demo)' : 'Team Lead (Demo)',
    submittedByName: incomplete ? null : 'Team Lead (Demo)',
    draftPayload: incomplete
      ? {
          team: { groupNumber: input.groupNumber },
          product: { productName: input.productName, ideaId: input.ideaId },
        }
      : {},
    draftUpdatedAt: incomplete ? hoursAgo(2) : input.submittedAt,
    submittedAt: input.submittedAt,
    receiptId: incomplete ? null : demoReceiptId(input.groupNumber),
    lockedAt: input.submittedAt,
    reopenedAt: null,
    reopenedReason: null,
    isLate: false,
    hasLateException: false,

    createdAt: hoursAgo(30),
    updatedAt: input.submittedAt ?? DEMO_NOW,
  };
}

interface SubmissionText {
  primaryUser: string;
  exactProblem: string;
  promise: string;
  description: string;
  whyAi: string;
  differentiation: string;
  mustHave: string;
  shouldHave: string[];
  excluded: string;
  testSteps: { action: string; expectedResult: string }[];
  sampleInputs: string;
  limitations: string;
  bugs: { description: string; howFixed: string }[];
  tradeoff: string;
  dayChanges: string;
  learning: string;
  nextPlan: string;
}

const BASE_TEXT: SubmissionText = {
  primaryUser: 'A working professional planning a short trip with one or two other people.',
  exactProblem:
    'Trip plans end up scattered across chat threads, screenshots and notes, so nobody can see one clear day-by-day plan and timing clashes are only noticed on the day.',
  promise: 'See your whole trip as one clear day-by-day plan in under ten minutes.',
  description:
    'Create a trip with a destination and dates, get a day generated for each date, then add activities with a time and a note to each day. The itinerary view shows everything in order, and an AI panel suggests activities for the destination.',
  whyAi:
    'The hardest part of planning is not recording activities, it is thinking of them. AI turns an empty day into three concrete, destination-relevant options the user can accept or ignore.',
  differentiation:
    'Existing tools are built around bookings. This is built around the day-by-day plan, so a trip with no bookings at all still works.',
  mustHave:
    'Create a trip, have days generated automatically for the date range, add and edit activities on a day, and see the complete day-by-day itinerary.',
  shouldHave: ['Mark an activity as must-do or optional', 'AI suggestions for three activities per day'],
  excluded: 'Map view, PDF export, booking imports and email parsing were all deliberately left out.',
  testSteps: [
    { action: 'Open the product URL', expectedResult: 'The trip list loads with a "Create trip" button visible.' },
    { action: 'Create a trip with a destination and a three-day date range', expectedResult: 'Three days are generated automatically.' },
    { action: 'Add an activity to day 1 with a time and a title', expectedResult: 'The activity appears under day 1 at the right time.' },
    { action: 'Reload the page', expectedResult: 'The trip and the activity are still there.' },
    { action: 'Edit the activity time', expectedResult: 'The updated time is shown in the itinerary.' },
    { action: 'Open the AI suggestions panel', expectedResult: 'Three suggested activities appear for the destination.' },
  ],
  sampleInputs: 'Destination: Lisbon. Dates: 15–17 June 2030. Activity: "Coffee at the market", 10:30.',
  limitations: 'Suggestions can be slow on the first request. There is no map view. Trips are single-user only.',
  bugs: [
    {
      description: 'Days were generated one short when the trip crossed a month boundary.',
      howFixed: 'The date loop used a day count instead of comparing dates; switched to comparing the actual end date.',
    },
    {
      description: 'Editing an activity created a duplicate instead of updating it.',
      howFixed: 'The save handler always inserted; it now updates when an id is present.',
    },
    {
      description: 'The itinerary showed activities in insertion order rather than by time.',
      howFixed: 'Added a sort by start time before rendering each day.',
    },
  ],
  tradeoff:
    'We dropped the map view so the edit and delete flow could be finished properly. A half-working map would have looked better in the deck but a broken edit flow would have made the product unusable.',
  dayChanges:
    'Day 12 ended with trip creation and a read-only itinerary. Day 13 added activity editing and deleting, fixed the month-boundary bug, and added the AI suggestions panel.',
  learning:
    'Getting one flow completely right was worth more than three flows that half worked. Every time we tested end to end we found something that only appeared in the full sequence.',
  nextPlan:
    'Fix the accessibility contrast issues, add error handling to the AI panel, add trip duplication, then test with five people who have never seen it.',
};

const SUBMISSION_TEXT: Record<DemoScenario, SubmissionText> = {
  complete: BASE_TEXT,
  incomplete: BASE_TEXT,
  inaccessible: {
    ...BASE_TEXT,
    primaryUser: 'A researcher gathering headings and links from public pages.',
    exactProblem:
      'Copying titles and links out of a page by hand is slow and error-prone, and the result ends up in an unstructured note.',
    promise: 'Turn any public page into a structured list of titles, headings and links.',
    mustHave: 'Enter a public URL, extract titles, headings and links, and save the result to review later.',
    limitations: 'Only public pages are supported. Very large pages can time out.',
  },
  login_required: {
    ...BASE_TEXT,
    primaryUser: 'A small team keeping shared notes for a recurring project.',
    exactProblem:
      'Shared notes end up in chat threads where nobody can find them again, and two people editing the same note overwrite each other.',
    promise: 'One place for your team’s notes, where edits do not get lost.',
    mustHave: 'Sign in, create a note, edit it, share it with a teammate, and see it in the notes list.',
    shouldHave: ['AI summary of a long note', 'Share a note by link'],
    limitations: 'Sharing links are new and not fully tested. There is no offline mode.',
  },
  manual_review: {
    ...BASE_TEXT,
    primaryUser: 'Someone training for a specific distance who wants to log runs.',
    exactProblem: 'Progress towards a goal is invisible when runs are logged in separate apps.',
    promise: 'Set one goal and watch it fill up.',
    mustHave: 'Set a goal, log progress against it, and see the progress on a dashboard.',
    limitations: 'The product is distributed as a native mobile application rather than a web app.',
  },
  low_confidence: {
    ...BASE_TEXT,
    primaryUser: 'Someone who keeps forgetting the films they meant to watch.',
    exactProblem: 'Film recommendations arrive in conversation and are forgotten before there is time to watch anything.',
    promise: 'Never lose track of a film someone recommended.',
    mustHave: 'Search for a film, add it to a watchlist, mark it watched, and rate it.',
    shouldHave: ['AI recommendation based on mood'],
    limitations: 'Search can be slow. The recommendation feature is new.',
  },
};

// --------------------------------------------------------------------------
// Assessment seeding
// --------------------------------------------------------------------------

function seedAssessment(
  db: MemoryDatabase,
  input: { cohortId: string; submissionId: string; groupNumber: number; scenario: DemoScenario },
): void {
  const jobId = demoJobId(input.groupNumber);
  const stage = STAGE_BY_SCENARIO[input.scenario];

  db.jobs.push({
    id: jobId,
    submissionId: input.submissionId,
    cohortId: input.cohortId,
    stage,
    priority: 0,
    attemptCount: input.scenario === 'inaccessible' ? 3 : 1,
    maxAttempts: DEMO_ASSESSMENT_CONFIG.maxAttempts,
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: hoursAgo(4),
    completedAt: stage === 'completed' ? hoursAgo(3) : null,
    lastError: input.scenario === 'inaccessible' ? 'DNS lookup failed: NXDOMAIN (attempt 3 of 3).' : null,
    nextAttemptAt: null,
    createdAt: hoursAgo(4.5),
    updatedAt: DEMO_NOW,
  });

  // Preflight
  buildDemoPreflight(input.scenario).forEach((check, index) => {
    db.preflight.push({
      id: id(`preflight-${input.groupNumber}-${index}`),
      jobId,
      checkKey: check.checkKey,
      status: check.status,
      attemptNumber: check.attemptNumber,
      failureClass: check.failureClass,
      detail: { message: check.detail },
      checkedAt: new Date(hoursAgo(4).getTime() + index * 1000),
    });
  });

  // Artifact analysis
  const videoLimited = input.scenario === 'low_confidence';
  db.artifactAnalyses.push({
    id: id(`analysis-${input.groupNumber}`),
    jobId,
    deckPageCount: input.scenario === 'low_confidence' ? 9 : 8,
    deckTextExtracted: input.scenario !== 'low_confidence',
    deckAnalysis: {
      templateCompliance: input.scenario === 'login_required' ? 'partial' : 'complete',
      placeholdersRemaining: input.scenario === 'login_required' ? 2 : 0,
      coversProblem: true,
      coversDemo: true,
    },
    videoAnalysisLimited: videoLimited,
    videoLimitationReason: videoLimited
      ? 'The demo link timed out on two attempts, so no video content could be analysed. No video content has been inferred.'
      : null,
    transcriptAvailable: false,
    writtenAnalysis: {
      declaredMustHaveWorkflow: SUBMISSION_TEXT[input.scenario].mustHave,
      specificityOfProblem: input.scenario === 'complete' ? 'high' : 'medium',
    },
    injectionFlags:
      input.scenario === 'inaccessible'
        ? [
            {
              source: 'deck',
              pattern: 'instruction-like text addressed to a reviewer',
              excerpt: '[flagged excerpt withheld from scoring input]',
              severity: 'low',
            },
          ]
        : [],
    modelVersion: DEMO_MODEL_VERSION,
    promptVersion: DEMO_PROMPT_VERSION,
    createdAt: hoursAgo(3.9),
  });

  // Manual review flags
  if (input.scenario === 'manual_review') {
    db.manualReviewFlags.push({
      id: id(`flag-${input.groupNumber}`),
      submissionId: input.submissionId,
      reasonCode: 'unsupported_product_type',
      detail:
        'The submitted URL serves an app-store listing for a native mobile application. Automated browser testing cannot assess this product type, so it needs a human reviewer.',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: hoursAgo(3.9),
    });
  }
  if (input.scenario === 'low_confidence') {
    db.manualReviewFlags.push({
      id: id(`flag-${input.groupNumber}`),
      submissionId: input.submissionId,
      reasonCode: 'low_confidence_scores',
      detail:
        'Four categories scored below the confidence threshold. The browser run hit its time budget and the deck could not be text-extracted, so several categories rest on thin evidence.',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: hoursAgo(3.1),
    });
  }

  // Disqualification proposal for the unreachable product
  if (input.scenario === 'inaccessible') {
    db.disqualifications.push({
      id: id(`dq-${input.groupNumber}`),
      submissionId: input.submissionId,
      reasonCode: 'artifact_inaccessible_after_retries',
      reasonDetail:
        'The product URL failed DNS resolution on three attempts across the grace period. The deck and demo video were both accessible, so this is specific to the product URL.',
      evidence: {
        attempts: 3,
        failureClass: 'dns',
        gracePeriodMs: DEMO_ASSESSMENT_CONFIG.gracePeriodMs,
        note: 'Proposed automatically. Requires admin confirmation — a DNS failure can also indicate a temporary outage.',
      },
      status: 'proposed',
      proposedBy: 'system',
      confirmedBy: null,
      reversedBy: null,
      reversedReason: null,
      createdAt: hoursAgo(2.5),
      updatedAt: hoursAgo(2.5),
    });
  }

  // Browser runs
  const runs = DEMO_BROWSER_RUNS[input.scenario] ?? [];
  runs.forEach((run, runIndex) => {
    const runId = id(`run-${input.groupNumber}-${runIndex}`);
    db.browserRuns.push({
      id: runId,
      jobId,
      // Fixtures are the job's first and only attempt.
      attempt: 1,
      viewport: run.viewport,
      startedAt: hoursAgo(3.8),
      finishedAt: new Date(hoursAgo(3.8).getTime() + run.durationMs),
      durationMs: run.durationMs,
      status: run.status,
      browserVersion: 'Chromium 131.0 (demo fixture)',
      tracePath: `traces/${input.submissionId}/${run.viewport}.zip`,
      consoleErrorCount: run.consoleErrorCount,
      networkFailureCount: run.networkFailureCount,
      a11yViolationCount: run.a11yViolationCount,
      a11ySummary: { ...run.a11ySummary },
      cleanupStatus: run.cleanupStatus,
      timedOut: run.timedOut,
    });
    run.steps.forEach((step, stepIndex) => {
      db.browserSteps.push({
        id: id(`step-${input.groupNumber}-${runIndex}-${stepIndex}`),
        runId,
        stepIndex,
        action: step.action,
        status: step.status,
        durationMs: step.durationMs,
        screenshotPath:
          step.action === 'screenshot'
            ? `submission-screenshots/${input.submissionId}/${step.detail}.png`
            : null,
        assertionDetail: { detail: step.detail },
        errorMessage: step.status === 'failed' ? step.detail : null,
      });
    });
  });

  // Scores, evidence, summary, feedback
  if (!SCENARIOS_WITH_SCORES.includes(input.scenario)) return;

  const scores = buildDemoScores(input.scenario);
  const now = hoursAgo(3);

  scores.forEach((score) => {
    db.scores.push({
      id: id(`score-${input.groupNumber}-${score.categoryKey}`),
      jobId,
      categoryKey: score.categoryKey,
      rawScore: score.rawScore,
      maxPoints: score.maxPoints,
      weightedScore: score.weightedScore,
      confidence: score.confidence,
      rationale: score.rationale,
      supportingEvidence: [...score.supportingEvidence],
      contradictoryEvidence: [...score.contradictoryEvidence],
      missingEvidence: [...score.missingEvidence],
      isOverridden: false,
      overrideReason: null,
      overriddenBy: null,
      overriddenAt: null,
      originalRawScore: null,
      modelVersion: DEMO_MODEL_VERSION,
      promptVersion: DEMO_PROMPT_VERSION,
      rubricVersion: RUBRIC_VERSION,
      createdAt: now,
      updatedAt: now,
    });

    // Evidence rows — the join that makes "every score has evidence" queryable.
    const category = RUBRIC_CATEGORIES.find((c) => c.key === score.categoryKey);
    const primarySource = category?.evidenceSources[0] ?? 'written';
    score.supportingEvidence.forEach((summary, i) => {
      db.evidence.push({
        id: id(`ev-s-${input.groupNumber}-${score.categoryKey}-${i}`),
        jobId,
        categoryKey: score.categoryKey,
        evidenceType: primarySource,
        stance: 'supporting',
        summary,
        sourceRef: { origin: 'demo-fixture' },
        confidence: score.confidence,
        createdAt: now,
      });
    });
    score.contradictoryEvidence.forEach((summary, i) => {
      db.evidence.push({
        id: id(`ev-c-${input.groupNumber}-${score.categoryKey}-${i}`),
        jobId,
        categoryKey: score.categoryKey,
        evidenceType: primarySource,
        stance: 'contradictory',
        summary,
        sourceRef: { origin: 'demo-fixture' },
        confidence: score.confidence,
        createdAt: now,
      });
    });
    score.missingEvidence.forEach((summary, i) => {
      db.evidence.push({
        id: id(`ev-m-${input.groupNumber}-${score.categoryKey}-${i}`),
        jobId,
        categoryKey: score.categoryKey,
        evidenceType: primarySource,
        stance: 'missing',
        summary,
        sourceRef: { origin: 'demo-fixture' },
        confidence: score.confidence,
        createdAt: now,
      });
    });
  });

  const confidences = scores.map((s) => s.confidence);
  const meanConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const minConfidence = Math.min(...confidences);

  db.summaries.push({
    id: id(`summary-${input.groupNumber}`),
    jobId,
    totalScore: totalScore(scores.map((s) => ({ categoryKey: s.categoryKey, weightedScore: s.weightedScore }))),
    meanConfidence: Math.round(meanConfidence * 100) / 100,
    minConfidence,
    lowConfidence: minConfidence < DEMO_ASSESSMENT_CONFIG.lowConfidenceThreshold,
    risks: SUMMARY_RISKS[input.scenario] ?? [],
    strengths: (DEMO_FEEDBACK[input.scenario]?.strengths ?? []).slice(0, 3),
    weaknesses: (DEMO_FEEDBACK[input.scenario]?.improvements ?? []).map((i) => i.title),
    internalNotes: null,
    bugsFound: (DEMO_FEEDBACK[input.scenario]?.bugs ?? []).map((b) => ({
      description: b.description,
      severity: 'medium' as const,
      evidence: b.evidence,
    })),
    modelVersion: DEMO_MODEL_VERSION,
    promptVersion: DEMO_PROMPT_VERSION,
    completedAt: now,
  });

  const feedback = DEMO_FEEDBACK[input.scenario];
  if (feedback) {
    db.feedbackReports.push({
      id: id(`feedback-${input.groupNumber}`),
      submissionId: input.submissionId,
      productSummary: feedback.productSummary,
      strengths: [...feedback.strengths],
      improvements: feedback.improvements.map((i) => ({ ...i })),
      bugs: feedback.bugs.map((b) => ({ ...b })),
      nextSevenDayPlan: [...feedback.nextSevenDayPlan],
      isExposedToParticipant: false,
      generatedAt: now,
      modelVersion: DEMO_MODEL_VERSION,
      promptVersion: DEMO_PROMPT_VERSION,
    });
  }

  // Consistency pass for the top-scoring submission
  if (input.scenario === 'complete') {
    db.consistencyReviews.push({
      id: id(`consistency-${input.groupNumber}`),
      jobId,
      triggerReason: ['top20'],
      passNumber: 2,
      scoreDelta: -0.5,
      adjusted: false,
      detail: {
        note: 'Second pass agreed within 0.5 points. No adjustment applied.',
        categoriesReviewed: RUBRIC_CATEGORIES.map((c) => c.key),
      },
      reviewedAt: hoursAgo(2.8),
    });
  }
}

const STAGE_BY_SCENARIO: Record<DemoScenario, AssessmentJob['stage']> = {
  complete: 'completed',
  incomplete: 'queued',
  inaccessible: 'failed',
  login_required: 'completed',
  manual_review: 'manual_review',
  low_confidence: 'completed',
};

const SUMMARY_RISKS: Partial<Record<DemoScenario, string[]>> = {
  complete: ['No AI failure path was observed, so resilience of the suggestion feature is unproven.'],
  login_required: [
    'Sharing is broken, and sharing is central to the product category.',
    'Real-time collaboration could not be verified from a single browser context.',
  ],
  low_confidence: [
    'The browser run hit its time budget, so part of the declared workflow was never exercised.',
    'The deck could not be text-extracted and the demo video could not be retrieved.',
    'Four categories fall below the confidence threshold — treat this score as provisional.',
  ],
};

// --------------------------------------------------------------------------
// Ranking
// --------------------------------------------------------------------------

function seedRanking(db: MemoryDatabase, cohort: Cohort): void {
  const snapshotId = id('ranking-snapshot-1');

  const rankable: RankableSubmission[] = [];
  for (const job of db.jobs) {
    if (job.stage !== 'completed') continue;
    const confirmedDq = db.disqualifications.some(
      (d) => d.submissionId === job.submissionId && d.status === 'confirmed',
    );
    if (confirmedDq) continue;

    const scores = db.scores.filter((s) => s.jobId === job.id);
    if (scores.length !== RUBRIC_CATEGORIES.length) continue;

    const summary = db.summaries.find((s) => s.jobId === job.id);
    const openFlags = db.manualReviewFlags.filter(
      (f) => f.submissionId === job.submissionId && f.status === 'open',
    ).length;

    rankable.push({
      submissionId: job.submissionId,
      scores: scores.map((s) => ({ categoryKey: s.categoryKey, weightedScore: s.weightedScore })),
      unresolvedRiskCount: openFlags + (summary?.risks.length ?? 0),
      meanConfidence: summary?.meanConfidence ?? 0,
    });
  }

  const ordered = [...rankable].sort(compareForRanking);

  db.rankingSnapshots.push({
    id: snapshotId,
    cohortId: cohort.id,
    generatedAt: hoursAgo(2),
    rubricVersion: RUBRIC_VERSION,
    eligibleCount: ordered.length,
    shortlistTarget: cohort.shortlistTarget,
    isCurrent: true,
    notes: 'Seeded demo ranking, generated from the fixture scores by the real ranking code.',
  });

  ordered.forEach((entry, index) => {
    const scores = entry.scores;
    db.rankingEntries.push({
      id: id(`ranking-entry-${index}`),
      snapshotId,
      submissionId: entry.submissionId,
      rank: index + 1,
      totalScore: totalScore(scores),
      tiebreakVector: {
        total: totalScore(scores),
        core_workflow: scores.find((s) => s.categoryKey === 'core_workflow')?.weightedScore ?? 0,
        solution_usefulness: scores.find((s) => s.categoryKey === 'solution_usefulness')?.weightedScore ?? 0,
        ai_usefulness: scores.find((s) => s.categoryKey === 'ai_usefulness')?.weightedScore ?? 0,
        two_day_execution: scores.find((s) => s.categoryKey === 'two_day_execution')?.weightedScore ?? 0,
        unresolvedRisks: entry.unresolvedRiskCount,
      },
      inShortlist: index < cohort.shortlistTarget,
      meanConfidence: entry.meanConfidence,
    });
  });

  // Final selections are left EMPTY on purpose. No system process may write
  // them — a human chooses the four winners (ADR-018).
}

function seedSettings(db: MemoryDatabase): void {
  const now = DEMO_NOW;
  const setting = (key: string, value: unknown, description: string): SystemSetting => ({
    key,
    value,
    description,
    updatedBy: null,
    updatedAt: now,
  });

  db.settings.push(
    setting('worker.concurrency', 4, 'How many submissions the worker processes at once.'),
    setting('worker.browserBudgetMs', 480_000, 'Wall-clock budget for browser testing one submission.'),
    setting('worker.maxAttempts', 3, 'Attempts before a job is parked as failed.'),
    setting('assessment.lowConfidenceThreshold', 0.6, 'Below this, a category is flagged for human review.'),
    setting('assessment.consistencyTopN', 20, 'How many top-ranked submissions get a second scoring pass.'),
    setting(
      'artifacts.allowedVideoHosts',
      ['loom.com', 'youtube.com', 'youtu.be', 'drive.google.com', 'vimeo.com'],
      'Demo video hosts accepted without a warning (ADR-023).',
    ),
    setting('retention.evidenceDays', 90, 'How long traces and evidence are kept.'),
    setting('retention.submissionDays', 90, 'How long submissions and reports are kept.'),
  );
}
