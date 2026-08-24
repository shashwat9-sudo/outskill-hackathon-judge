/**
 * Structured-output schemas.
 *
 * Every AI call validates against one of these. This is the layer that makes
 * prompt injection structurally ineffective: whatever a model is persuaded to
 * say, only data matching these shapes reaches the pipeline, and none of these
 * shapes carries an instruction.
 */

import { z } from 'zod';
import { RUBRIC_CATEGORY_KEYS, testStepSchema } from '@ohj/shared/client';

// --------------------------------------------------------------------------
// Artifact analysis
// --------------------------------------------------------------------------

export const artifactAnalysisSchema = z.object({
  deck: z.object({
    coversProblem: z.boolean(),
    coversProduct: z.boolean(),
    coversDemo: z.boolean(),
    /** Unedited template text is an incomplete-deck signal, never a DQ ground. */
    placeholdersRemaining: z.number().int().min(0).max(50),
    templateCompliance: z.enum(['complete', 'partial', 'none']),
    /** Claims made in the deck, to be checked against observed behaviour. */
    claimsMade: z.array(z.string().max(300)).max(15),
    notes: z.string().max(1000),
  }),
  written: z.object({
    problemSpecificity: z.enum(['high', 'medium', 'low']),
    targetUserSpecificity: z.enum(['high', 'medium', 'low']),
    promiseIsCheckable: z.boolean(),
    /** Restated from the team's own words, for the test planner. */
    declaredMustHaveWorkflow: z.string().max(600),
    aiRoleDescribed: z.string().max(600),
    notes: z.string().max(1000),
  }),
  risks: z.array(z.string().max(300)).max(10),
});

export type ArtifactAnalysisOutput = z.infer<typeof artifactAnalysisSchema>;

// --------------------------------------------------------------------------
// Test plan
// --------------------------------------------------------------------------

export const testPlanOutputSchema = z.object({
  summary: z.string().max(1000),
  steps: z.array(testStepSchema).min(1).max(80),
  estimatedDurationMs: z.number().int().min(1000).max(900_000),
});

export type TestPlanOutput = z.infer<typeof testPlanOutputSchema>;

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------

const evidenceList = z.array(z.string().min(1).max(400)).max(10);

export const categoryScoreSchema = z.object({
  categoryKey: z.enum(RUBRIC_CATEGORY_KEYS),
  rawScore: z.number().min(0),
  /** Independent of the score: how sure the model is that it had enough to go on. */
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(1000),
  supportingEvidence: evidenceList,
  contradictoryEvidence: evidenceList,
  missingEvidence: evidenceList,
});

export const scoringOutputSchema = z.object({
  // Exactly the eight categories — a partial score set must not rank.
  scores: z.array(categoryScoreSchema).length(RUBRIC_CATEGORY_KEYS.length),
  strengths: z.array(z.string().max(400)).max(5),
  weaknesses: z.array(z.string().max(400)).max(5),
  risks: z.array(z.string().max(400)).max(8),
  bugsFound: z
    .array(
      z.object({
        description: z.string().max(400),
        severity: z.enum(['low', 'medium', 'high']),
        evidence: z.string().max(400),
      }),
    )
    .max(10),
});

export type ScoringOutput = z.infer<typeof scoringOutputSchema>;

/**
 * Reject a score set where a category exceeds its ceiling or all evidence is
 * absent. Zod cannot express "raw score ≤ this category's max" alone, because
 * the ceiling depends on the category.
 */
export function validateScoreCeilings(
  output: ScoringOutput,
  maxPointsFor: (key: string) => number,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const score of output.scores) {
    if (seen.has(score.categoryKey)) problems.push(`Duplicate category: ${score.categoryKey}`);
    seen.add(score.categoryKey);

    const max = maxPointsFor(score.categoryKey);
    if (score.rawScore > max) {
      problems.push(`${score.categoryKey} scored ${score.rawScore}, above its maximum of ${max}`);
    }
    const evidenceCount =
      score.supportingEvidence.length + score.contradictoryEvidence.length + score.missingEvidence.length;
    if (evidenceCount === 0) {
      problems.push(`${score.categoryKey} has no evidence of any kind`);
    }
  }

  for (const key of RUBRIC_CATEGORY_KEYS) {
    if (!seen.has(key)) problems.push(`Missing category: ${key}`);
  }

  return { ok: problems.length === 0, problems };
}

// --------------------------------------------------------------------------
// Consistency review
// --------------------------------------------------------------------------

export const consistencyOutputSchema = z.object({
  agreesWithFirstPass: z.boolean(),
  categoryAdjustments: z
    .array(
      z.object({
        categoryKey: z.enum(RUBRIC_CATEGORY_KEYS),
        suggestedScore: z.number().min(0),
        reason: z.string().max(600),
      }),
    )
    .max(8),
  notes: z.string().max(1000),
});

export type ConsistencyOutput = z.infer<typeof consistencyOutputSchema>;

// --------------------------------------------------------------------------
// Participant feedback
// --------------------------------------------------------------------------

export const feedbackOutputSchema = z.object({
  productSummary: z.string().min(1).max(800),
  /** Exactly three each — the feedback-quality rules ask for a bounded, prioritised set. */
  strengths: z.array(z.string().min(1).max(600)).length(3),
  improvements: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        detail: z.string().min(1).max(800),
        priority: z.number().int().min(1).max(3),
      }),
    )
    .length(3),
  bugs: z
    .array(z.object({ description: z.string().max(400), evidence: z.string().max(400) }))
    .max(8),
  nextSevenDayPlan: z.array(z.string().min(1).max(300)).min(2).max(6),
});

export type FeedbackOutput = z.infer<typeof feedbackOutputSchema>;

/**
 * Guard the participant-facing report.
 *
 * Feedback must never leak ranking, other teams, or internal scoring logic —
 * and this is enforced rather than trusted, because the report is the artefact
 * most likely to be shown to a learner in a future version.
 */
/*
 * What a participant must never learn from their feedback: where they placed,
 * what they were marked, and how they compare to anyone else.
 *
 * These were once plain word bans — `\bpoints?\b`, `\bscore[ds]?\b`,
 * `\bconfidence\b`, `\brank(?:ed|ing)?\b` — and they did not survive contact
 * with English. "Pain point", "at this point", "users can act with confidence",
 * "a ranked list of recipes" are ordinary feedback prose that leaks nothing,
 * and the check rejected the whole report over any one of them. On the C13 run
 * that silently withheld 43 of 69 reports; every production log line cites the
 * word "point".
 *
 * A control that fires overwhelmingly on false positives does not protect
 * anybody — it gets the feature switched off, which is exactly what happened,
 * except nobody decided to switch it off and nobody knew it had been.
 *
 * So the judging sense is matched rather than the word. "You scored 61", "61 /
 * 100", "ranked 7th", "your confidence rating", "top 10", "shortlist",
 * "winner", "compared to other teams" are all still refused. `feedback-safety
 * .test.ts` holds both halves: every real leak still caught, and the ordinary
 * phrasing that used to be rejected now allowed.
 */
const FORBIDDEN_IN_FEEDBACK = [
  // Placement, in any phrasing that actually states one.
  /\bshortlist/i,
  /\btop\s*(?:10|ten|four|4)\b/i,
  /\bwinner\b/i,
  /\bdisqualif/i,
  /\brank(?:ed|ing|s)?\s*(?:#|no\.?|number|position)?\s*\d+/i,
  /\b(?:your|the)\s+rank(?:ing)?\b/i,
  /\brank(?:ed)?\s+(?:first|second|third|fourth|fifth|highest|lowest|top|bottom|among|against)\b/i,

  // A mark, in any phrasing that actually states one.
  /\b\d{1,3}\s*\/\s*100\b/,
  /\b(?:your|the|a|an|final|total|overall)\s+scores?\b/i,
  /\bscored?\s+(?:\d+|highly|well|poorly|low|high)\b/i,
  /\bscore\s+of\b/i,
  /\b\d+(?:\.\d+)?\s*(?:out of|\/)\s*\d/i,
  /\b\d+(?:\.\d+)?\s*points?\b/i,
  /\b(?:your|the|these|those)\s+points\b/i,
  /\bmarks?\s+(?:awarded|given|out of)\b/i,

  // How sure the judge was — never the participant's business.
  /\bconfidence\s*(?:score|level|rating|value)\b/i,
  /\blow[-\s]confidence\b/i,

  // Anyone else's performance.
  /\bother teams?\b/i,
  /\bcompared to\b/i,
  /\brelative to (?:other|the other)\b/i,
];

export function validateFeedbackSafety(output: FeedbackOutput): { ok: boolean; problems: string[] } {
  const serialised = JSON.stringify(output);
  const problems: string[] = [];

  for (const pattern of FORBIDDEN_IN_FEEDBACK) {
    const match = pattern.exec(serialised);
    if (match) {
      problems.push(`Feedback mentions "${match[0]}", which participants must not see.`);
    }
  }

  return { ok: problems.length === 0, problems };
}
