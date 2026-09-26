import { describe, expect, it } from 'vitest';
import {
  canParticipantEdit,
  canTransitionAssessment,
  canTransitionCohort,
  canTransitionSubmission,
  assertAssessmentTransition,
  isCohortAcceptingSubmissions,
  nextHappyStage,
  ASSESSMENT_HAPPY_PATH,
} from './status';
import { evaluateDeadline, evaluateShortlistWindow, isSubmissionLate, shortlistDueAt } from './deadline';
import {
  DISQUALIFICATION_REASONS,
  NEVER_DISQUALIFY,
  assertDisqualificationAllowed,
  isEligibleForRanking,
  isPermittedDisqualificationReason,
  proposeDisqualifications,
  type DisqualificationCandidateInput,
} from './disqualification';
import {
  compareForRanking,
  rankSubmissions,
  selectForConsistencyReview,
  validateFinalSelection,
  type RankableSubmission,
} from './ranking';
import { anonymiseSubmissionId, generateReceiptId, isValidReceiptId } from './ids';
import { RUBRIC_CATEGORIES } from '../rubric/index';

// --------------------------------------------------------------------------
// Status transitions
// --------------------------------------------------------------------------

describe('cohort status transitions', () => {
  it('allows the normal operating path', () => {
    expect(canTransitionCohort('draft', 'open').allowed).toBe(true);
    expect(canTransitionCohort('open', 'paused').allowed).toBe(true);
    expect(canTransitionCohort('paused', 'open').allowed).toBe(true);
    expect(canTransitionCohort('open', 'closed').allowed).toBe(true);
    expect(canTransitionCohort('closed', 'judging').allowed).toBe(true);
    expect(canTransitionCohort('judging', 'finalised').allowed).toBe(true);
  });

  it('rejects skipping straight from draft to judging', () => {
    const result = canTransitionCohort('draft', 'judging');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Illegal cohort transition/);
  });

  it('treats archived as terminal', () => {
    expect(canTransitionCohort('archived', 'open').allowed).toBe(false);
    expect(canTransitionCohort('finalised', 'archived').allowed).toBe(true);
  });

  it('lets a finalised cohort return to judging so a decision can be corrected', () => {
    expect(canTransitionCohort('finalised', 'judging').allowed).toBe(true);
  });
});

describe('submission status transitions', () => {
  it('allows draft → submitted → locked → reopened', () => {
    expect(canTransitionSubmission('draft', 'submitted').allowed).toBe(true);
    expect(canTransitionSubmission('submitted', 'locked').allowed).toBe(true);
    expect(canTransitionSubmission('locked', 'reopened').allowed).toBe(true);
    expect(canTransitionSubmission('reopened', 'submitted').allowed).toBe(true);
  });

  it('does not allow a locked submission to silently return to draft', () => {
    expect(canTransitionSubmission('locked', 'draft').allowed).toBe(false);
  });
});

describe('participant edit permission', () => {
  it('requires BOTH an open cohort and an editable submission', () => {
    expect(canParticipantEdit('open', 'draft')).toBe(true);
    expect(canParticipantEdit('open', 'reopened')).toBe(true);
    expect(canParticipantEdit('open', 'locked')).toBe(false);
    // A reopened submission in a closed cohort stays read-only.
    expect(canParticipantEdit('closed', 'reopened')).toBe(false);
    expect(canParticipantEdit('judging', 'draft')).toBe(false);
    expect(canParticipantEdit('paused', 'draft')).toBe(false);
  });

  it('only accepts submissions while the cohort is open', () => {
    expect(isCohortAcceptingSubmissions('open')).toBe(true);
    for (const status of ['draft', 'paused', 'closed', 'judging', 'finalised', 'archived'] as const) {
      expect(isCohortAcceptingSubmissions(status), status).toBe(false);
    }
  });
});

describe('assessment stage transitions', () => {
  it('follows the happy path in order', () => {
    for (let i = 0; i < ASSESSMENT_HAPPY_PATH.length - 1; i++) {
      const from = ASSESSMENT_HAPPY_PATH[i]!;
      const to = ASSESSMENT_HAPPY_PATH[i + 1]!;
      expect(canTransitionAssessment(from, to).allowed, `${from} → ${to}`).toBe(true);
    }
  });

  it('allows any processing stage to divert to manual review, failure, or disqualification', () => {
    for (const stage of ['preflight', 'artifact_analysis', 'browser_testing', 'scoring'] as const) {
      expect(canTransitionAssessment(stage, 'manual_review').allowed).toBe(true);
      expect(canTransitionAssessment(stage, 'failed').allowed).toBe(true);
      expect(canTransitionAssessment(stage, 'disqualified').allowed).toBe(true);
    }
  });

  it('rejects skipping browser testing to go straight to scoring', () => {
    // Scoring without browser evidence would produce unsupported scores.
    expect(canTransitionAssessment('test_plan_generation', 'scoring').allowed).toBe(false);
  });

  it('lets an admin rerun a terminal job by re-queueing it', () => {
    expect(canTransitionAssessment('completed', 'queued').allowed).toBe(true);
    expect(canTransitionAssessment('failed', 'queued').allowed).toBe(true);
    expect(canTransitionAssessment('disqualified', 'queued').allowed).toBe(true);
  });

  it('throws on an illegal transition when asserted', () => {
    expect(() => assertAssessmentTransition('queued', 'scoring')).toThrow(/Illegal assessment transition/);
  });

  it('reports the next happy stage and stops at completed', () => {
    expect(nextHappyStage('queued')).toBe('preflight');
    expect(nextHappyStage('scoring')).toBe('consistency_review');
    expect(nextHappyStage('completed')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Deadline
// --------------------------------------------------------------------------

describe('deadline evaluation', () => {
  // 11:59 PM IST on Day 13 == 18:29 UTC.
  const deadline = new Date('2026-03-13T18:29:00.000Z');

  it('treats a submission one second before the deadline as on time', () => {
    expect(isSubmissionLate(new Date('2026-03-13T18:28:59.000Z'), deadline)).toBe(false);
  });

  it('treats a submission one second after the deadline as late', () => {
    expect(isSubmissionLate(new Date('2026-03-13T18:29:01.000Z'), deadline)).toBe(true);
  });

  it('never marks an unsubmitted draft as late', () => {
    // A draft is not late, it is unsubmitted — conflating them would let a
    // draft be auto-disqualified for lateness.
    expect(isSubmissionLate(null, deadline)).toBe(false);
  });

  it('reports time remaining before the deadline', () => {
    const evaluation = evaluateDeadline(deadline, new Date('2026-03-13T15:29:00.000Z'));
    expect(evaluation.hasPassed).toBe(false);
    expect(evaluation.isLate).toBe(false);
    expect(evaluation.remainingLabel).toContain('3 hours');
  });

  it('places the shortlist deadline ten hours after the submission deadline', () => {
    // 11:59 PM IST Day 13 → 10:00 AM IST Day 14 (roughly ten hours).
    const due = shortlistDueAt(deadline);
    expect(due.toISOString()).toBe('2026-03-14T04:29:00.000Z');
  });

  it('says whether judging is on track for the shortlist commitment', () => {
    const onTrack = evaluateShortlistWindow(
      deadline,
      new Date('2026-03-14T02:00:00.000Z'),
      new Date('2026-03-13T20:00:00.000Z'),
    );
    expect(onTrack.onTrack).toBe(true);
    expect(onTrack.label).toMatch(/On track/);

    const behind = evaluateShortlistWindow(
      deadline,
      new Date('2026-03-14T08:00:00.000Z'),
      new Date('2026-03-13T20:00:00.000Z'),
    );
    expect(behind.onTrack).toBe(false);
    expect(behind.label).toMatch(/Behind/);
  });
});

// --------------------------------------------------------------------------
// Disqualification
// --------------------------------------------------------------------------

describe('disqualification grounds', () => {
  it('permits exactly the eleven grounds from the event rules', () => {
    expect(DISQUALIFICATION_REASONS).toHaveLength(11);
  });

  it('rejects every ground that must never disqualify a team', () => {
    for (const reason of NEVER_DISQUALIFY) {
      expect(isPermittedDisqualificationReason(reason), reason).toBe(false);
      expect(() => assertDisqualificationAllowed(reason, { proposedBySystem: false })).toThrow();
    }
  });

  it('specifically refuses low score, weak UI, and AI suspicion', () => {
    for (const reason of ['low_score', 'weak_ui', 'ai_suspicion_without_human_confirmation']) {
      expect(() => assertDisqualificationAllowed(reason, { proposedBySystem: true })).toThrow();
    }
  });

  it('does not let the system propose grounds that require human confirmation', () => {
    for (const reason of [
      'malicious_or_prohibited_content',
      'interference_with_judging',
      'confirmed_false_declaration',
      'confirmed_serious_rule_violation',
    ]) {
      expect(() => assertDisqualificationAllowed(reason, { proposedBySystem: true })).toThrow(
        /human confirmation/,
      );
      // ...but a human may record them.
      expect(() => assertDisqualificationAllowed(reason, { proposedBySystem: false })).not.toThrow();
    }
  });
});

describe('automatic disqualification proposals', () => {
  const base: DisqualificationCandidateInput = {
    hasProductUrl: true,
    hasDeckPdf: true,
    hasDemoLink: true,
    ideaIsApproved: true,
    isLate: false,
    hasLateException: false,
    loginRequired: false,
    hasWorkingCredentials: false,
    requiredArtifactInaccessible: false,
    retriesExhausted: false,
    gracePeriodElapsed: false,
    failuresLookLikeOutage: false,
  };

  it('proposes nothing for a compliant submission', () => {
    expect(proposeDisqualifications(base)).toEqual([]);
  });

  it('proposes for each objective missing requirement', () => {
    expect(proposeDisqualifications({ ...base, hasProductUrl: false })[0]?.code).toBe('missing_product_url');
    expect(proposeDisqualifications({ ...base, hasDeckPdf: false })[0]?.code).toBe('missing_pdf_deck');
    expect(proposeDisqualifications({ ...base, hasDemoLink: false })[0]?.code).toBe('missing_demo_link');
    expect(proposeDisqualifications({ ...base, ideaIsApproved: false })[0]?.code).toBe(
      'idea_outside_approved_list',
    );
  });

  it('does not propose lateness when an exception is on file', () => {
    expect(proposeDisqualifications({ ...base, isLate: true })).toHaveLength(1);
    expect(proposeDisqualifications({ ...base, isLate: true, hasLateException: true })).toHaveLength(0);
  });

  it('proposes when login is required but no working credentials exist', () => {
    const proposals = proposeDisqualifications({ ...base, loginRequired: true, hasWorkingCredentials: false });
    expect(proposals[0]?.code).toBe('login_required_without_working_credentials');

    expect(
      proposeDisqualifications({ ...base, loginRequired: true, hasWorkingCredentials: true }),
    ).toHaveLength(0);
  });

  it('never proposes disqualification for what looks like a temporary outage', () => {
    const inaccessible = {
      ...base,
      requiredArtifactInaccessible: true,
      retriesExhausted: true,
      gracePeriodElapsed: true,
    };
    expect(proposeDisqualifications(inaccessible)).toHaveLength(1);
    // The same facts, but classified as an outage — must not be proposed.
    expect(proposeDisqualifications({ ...inaccessible, failuresLookLikeOutage: true })).toHaveLength(0);
  });

  it('does not propose before retries are exhausted or the grace period elapses', () => {
    expect(
      proposeDisqualifications({ ...base, requiredArtifactInaccessible: true, retriesExhausted: false, gracePeriodElapsed: true }),
    ).toHaveLength(0);
    expect(
      proposeDisqualifications({ ...base, requiredArtifactInaccessible: true, retriesExhausted: true, gracePeriodElapsed: false }),
    ).toHaveLength(0);
  });
});

describe('ranking eligibility', () => {
  it('excludes only confirmed disqualifications, not proposals', () => {
    expect(
      isEligibleForRanking({ submissionStatus: 'locked', hasConfirmedDisqualification: false, hasCompleteScores: true }),
    ).toBe(true);
    expect(
      isEligibleForRanking({ submissionStatus: 'locked', hasConfirmedDisqualification: true, hasCompleteScores: true }),
    ).toBe(false);
  });

  it('excludes drafts and partially-scored submissions', () => {
    expect(
      isEligibleForRanking({ submissionStatus: 'draft', hasConfirmedDisqualification: false, hasCompleteScores: true }),
    ).toBe(false);
    expect(
      isEligibleForRanking({ submissionStatus: 'locked', hasConfirmedDisqualification: false, hasCompleteScores: false }),
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Ranking
// --------------------------------------------------------------------------

function makeEntry(
  submissionId: string,
  overrides: Partial<Record<string, number>> = {},
  unresolvedRiskCount = 0,
): RankableSubmission {
  return {
    submissionId,
    scores: RUBRIC_CATEGORIES.map((c) => ({
      categoryKey: c.key,
      weightedScore: overrides[c.key] ?? c.maxPoints * 0.5,
    })),
    unresolvedRiskCount,
    meanConfidence: 0.8,
  };
}

describe('tie-breaking', () => {
  it('ranks by total score first', () => {
    const high = makeEntry('high', { core_workflow: 25 });
    const low = makeEntry('low', { core_workflow: 10 });
    expect(compareForRanking(high, low)).toBeLessThan(0);
  });

  it('breaks a total-score tie on core workflow', () => {
    // Same total; A has more core workflow and less problem clarity.
    const a = makeEntry('a', { core_workflow: 20, problem_clarity: 2.5 });
    const b = makeEntry('b', { core_workflow: 15, problem_clarity: 7.5 });
    expect(a.scores.reduce((s, x) => s + x.weightedScore, 0)).toBe(
      b.scores.reduce((s, x) => s + x.weightedScore, 0),
    );
    expect(compareForRanking(a, b)).toBeLessThan(0);
  });

  it('falls through core workflow to solution_usefulness', () => {
    const a = makeEntry('a', { core_workflow: 20, solution_usefulness: 12, problem_clarity: 3 });
    const b = makeEntry('b', { core_workflow: 20, solution_usefulness: 8, problem_clarity: 7 });
    expect(compareForRanking(a, b)).toBeLessThan(0);
  });

  it('prefers fewer unresolved risks when every score matches', () => {
    const fewer = makeEntry('fewer', {}, 1);
    const more = makeEntry('more', {}, 5);
    expect(compareForRanking(fewer, more)).toBeLessThan(0);
  });

  it('is deterministic for genuinely identical entries', () => {
    const a = makeEntry('aaa');
    const b = makeEntry('bbb');
    expect(compareForRanking(a, b)).toBeLessThan(0);
    expect(compareForRanking(b, a)).toBeGreaterThan(0);
    // Stable across repeated sorts.
    expect(rankSubmissions([b, a]).map((e) => e.submissionId)).toEqual(['aaa', 'bbb']);
    expect(rankSubmissions([a, b]).map((e) => e.submissionId)).toEqual(['aaa', 'bbb']);
  });
});

describe('shortlist highlighting', () => {
  it('marks exactly the top N as shortlisted', () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeEntry(`sub-${String(i).padStart(2, '0')}`, { core_workflow: 25 - i }),
    );
    const ranked = rankSubmissions(entries, { shortlistTarget: 10 });
    expect(ranked.filter((e) => e.inShortlist)).toHaveLength(10);
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[9]?.inShortlist).toBe(true);
    expect(ranked[10]?.inShortlist).toBe(false);
  });

  it('handles fewer eligible submissions than the shortlist target', () => {
    const ranked = rankSubmissions([makeEntry('a'), makeEntry('b')], { shortlistTarget: 10 });
    expect(ranked.every((e) => e.inShortlist)).toBe(true);
  });
});

describe('consistency-pass selection', () => {
  it('selects the top 20, low-confidence, manual-review, and near-cutoff cases', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeEntry(`sub-${String(i).padStart(2, '0')}`, { core_workflow: 25 - i * 0.5 }),
    );
    const ranked = rankSubmissions(entries, { shortlistTarget: 10 });

    const candidates = selectForConsistencyReview(ranked, {
      shortlistTarget: 10,
      lowConfidenceIds: new Set(['sub-28']),
      manualReviewIds: new Set(['sub-29']),
      disputedIds: new Set(),
    });

    const ids = new Set(candidates.map((c) => c.submissionId));
    expect(ids.has('sub-00')).toBe(true); // top 20
    expect(ids.has('sub-28')).toBe(true); // low confidence
    expect(ids.has('sub-29')).toBe(true); // manual review

    const lowConfidence = candidates.find((c) => c.submissionId === 'sub-28');
    expect(lowConfidence?.triggers).toContain('low_confidence');
  });

  it('flags entries within two points of the shortlist cutoff', () => {
    const entries = Array.from({ length: 14 }, (_, i) =>
      makeEntry(`sub-${String(i).padStart(2, '0')}`, { core_workflow: 25 - i * 0.25 }),
    );
    const ranked = rankSubmissions(entries, { shortlistTarget: 10 });
    const candidates = selectForConsistencyReview(ranked, {
      shortlistTarget: 10,
      lowConfidenceIds: new Set(),
      manualReviewIds: new Set(),
      disputedIds: new Set(),
    });
    const nearCutoff = candidates.filter((c) => c.triggers.includes('near_cutoff'));
    expect(nearCutoff.length).toBeGreaterThan(0);
  });
});

describe('final selection', () => {
  const eligible = new Set(['a', 'b', 'c', 'd', 'e']);

  it('requires exactly the cohort target when one is given — three for C14', () => {
    const three = [
      { submissionId: 'a', position: 1 },
      { submissionId: 'b', position: 2 },
      { submissionId: 'c', position: 3 },
    ];
    expect(validateFinalSelection(three, eligible, 3).valid).toBe(true);
    expect(validateFinalSelection(three.slice(0, 2), eligible, 3).valid).toBe(false);
    expect(validateFinalSelection([...three, { submissionId: 'd', position: 4 }], eligible, 3).valid).toBe(false);
    expect(validateFinalSelection([...three, { submissionId: 'd', position: 4 }], eligible, 3).problems.join(' ')).toMatch(
      /Exactly 3 winners/,
    );
    // Positions must be 1..3 even when the count is right.
    expect(
      validateFinalSelection(
        [
          { submissionId: 'a', position: 1 },
          { submissionId: 'b', position: 2 },
          { submissionId: 'c', position: 4 },
        ],
        eligible,
        3,
      ).problems.join(' '),
    ).toMatch(/Positions must be exactly 1, 2, 3/);
  });

  it('refuses a nonsensical target rather than guessing', () => {
    expect(validateFinalSelection([], eligible, 0).valid).toBe(false);
    expect(validateFinalSelection([], eligible, 2.5).valid).toBe(false);
    expect(validateFinalSelection([], eligible, 101).problems.join(' ')).toMatch(/between 1 and 100/);
  });

  it('defaults to the historical four when no target is given', () => {
    expect(
      validateFinalSelection(
        [
          { submissionId: 'a', position: 1 },
          { submissionId: 'b', position: 2 },
          { submissionId: 'c', position: 3 },
        ],
        eligible,
      ).valid,
    ).toBe(false);

    expect(
      validateFinalSelection(
        [
          { submissionId: 'a', position: 1 },
          { submissionId: 'b', position: 2 },
          { submissionId: 'c', position: 3 },
          { submissionId: 'd', position: 4 },
        ],
        eligible,
      ).valid,
    ).toBe(true);
  });

  it('requires positions 1–4 with no duplicates', () => {
    const result = validateFinalSelection(
      [
        { submissionId: 'a', position: 1 },
        { submissionId: 'b', position: 1 },
        { submissionId: 'c', position: 3 },
        { submissionId: 'd', position: 4 },
      ],
      eligible,
    );
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/Positions must be/);
  });

  it('rejects the same submission in two positions', () => {
    const result = validateFinalSelection(
      [
        { submissionId: 'a', position: 1 },
        { submissionId: 'a', position: 2 },
        { submissionId: 'c', position: 3 },
        { submissionId: 'd', position: 4 },
      ],
      eligible,
    );
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/two positions/);
  });

  it('rejects an ineligible submission', () => {
    const result = validateFinalSelection(
      [
        { submissionId: 'a', position: 1 },
        { submissionId: 'b', position: 2 },
        { submissionId: 'c', position: 3 },
        { submissionId: 'disqualified-team', position: 4 },
      ],
      eligible,
    );
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/not eligible/);
  });
});

// --------------------------------------------------------------------------
// Identifiers
// --------------------------------------------------------------------------

describe('identifiers', () => {
  it('generates readable, valid receipt ids that embed the group number', () => {
    const receipt = generateReceiptId('AIAPD1', 42);
    expect(receipt).toMatch(/^OSK-AIAPD1-042-/);
    expect(isValidReceiptId(receipt)).toBe(true);
  });

  it('omits characters people misread when reading a receipt aloud', () => {
    for (let i = 0; i < 50; i++) {
      const tail = generateReceiptId('AIAPD1', 1).split('-')[3] ?? '';
      expect(tail).not.toMatch(/[ILOU]/);
    }
  });

  it('anonymises submission ids deterministically without leaking the original', () => {
    const anonymised = anonymiseSubmissionId('submission-uuid-1234', 'cohort-salt');
    expect(anonymised).toMatch(/^SUB-[0-9A-F]{12}$/);
    expect(anonymised).not.toContain('1234');
    expect(anonymiseSubmissionId('submission-uuid-1234', 'cohort-salt')).toBe(anonymised);
  });

  it('produces different anonymised ids per cohort for the same submission', () => {
    // So an AI provider cannot link the same team across two cohorts.
    expect(anonymiseSubmissionId('same-submission', 'cohort-a')).not.toBe(
      anonymiseSubmissionId('same-submission', 'cohort-b'),
    );
  });
});
