/**
 * Submission schemas — one per portal step.
 *
 * Every historical data-quality failure listed in the submission-quality notes
 * is prevented here by a typed field rather than by asking participants to be
 * careful: group numbers are integers, decks are file uploads (so the field
 * cannot hold a Loom URL), credentials have dedicated encrypted fields (so they
 * cannot end up in the product-URL field), and so on.
 *
 * Two levels of validation:
 *   - `*DraftSchema`  — permissive, used for autosave. A half-typed step must
 *                       always be savable, or teams lose work.
 *   - `*Schema`       — strict, used at Final Submit.
 */

import { z } from 'zod';
import { validateProductUrl, validateDemoVideoUrl } from '../security/url';

// --------------------------------------------------------------------------
// Shared field helpers
// --------------------------------------------------------------------------

const trimmed = (schema: z.ZodString) => z.string().trim().pipe(schema);

/**
 * Text helpers.
 *
 * `required_error` and `invalid_type_error` matter as much as the length rules:
 * a MISSING field reports the type error, not the min-length one, and Zod's
 * default for that is the bare word "Required" — which told a participant
 * nothing on the review screen.
 */
const shortText = (max: number, label: string) =>
  z
    .string({
      required_error: `${label} is required.`,
      invalid_type_error: `${label} is required.`,
    })
    .trim()
    .pipe(
      z
        .string()
        .min(1, `${label} is required.`)
        .max(max, `${label} must be ${max} characters or fewer.`),
    );

const longText = (min: number, max: number, label: string) =>
  z
    .string({
      required_error: `${label} is required.`,
      invalid_type_error: `${label} is required.`,
    })
    .trim()
    .pipe(
      z
        .string()
        .min(min, `${label} needs at least ${min} characters — enough to be specific.`)
        .max(max, `${label} must be ${max} characters or fewer.`),
    );

/** Group number: integer 1–999, unique per cohort (ADR-022). */
export const groupNumberSchema = z.coerce
  .number({ invalid_type_error: 'Group number must be a number.' })
  .int('Group number must be a whole number.')
  .min(1, 'Group number must be at least 1.')
  .max(999, 'Group number must be 999 or lower.');

export const emailSchema = trimmed(
  z.string().min(1, 'Email is required.').email('Enter a valid email address.').max(320),
);

/**
 * Phone: permissive on formatting, strict on content.
 *
 * Historical submissions arrived in a dozen formats — `+91 98765 43210`,
 * `(044) 2345-6789`, `98765-43210`. Rejecting any of those would push people
 * into retyping a correct number until it was accepted, so the rule is about
 * *content* (an optional leading +, then 7–15 digits, and no letters) rather
 * than about separators.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone number is required.')
  .max(32, 'Phone number is too long.')
  .refine((v) => /^[+]?[\d\s\-().]+$/.test(v), 'A phone number should not contain letters.')
  .refine((v) => {
    const digits = v.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
  }, 'Enter a phone number with between 7 and 15 digits.');

/** Strip formatting for storage and comparison, keeping any country prefix. */
export function normalisePhone(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** Product URL, validated through the shared SSRF-aware validator. */
export const productUrlSchema = z
  .string()
  .trim()
  .min(1, 'The live product URL is required.')
  .superRefine((value, ctx) => {
    const result = validateProductUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message ?? 'Invalid URL.' });
    }
  });

export const demoVideoUrlSchema = z
  .string()
  .trim()
  .min(1, 'A demo video link is required.')
  .superRefine((value, ctx) => {
    const result = validateDemoVideoUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message ?? 'Invalid URL.' });
    }
  });

// --------------------------------------------------------------------------
// Step 1 — Team
// --------------------------------------------------------------------------

export const teamMemberSchema = z.object({
  fullName: shortText(120, 'Member name'),
  contribution: longText(10, 300, 'Contribution'),
  isActive: z.boolean().default(true),
});

export const teamStepSchema = z.object({
  groupNumber: groupNumberSchema,
  leadName: shortText(120, 'Team lead name'),
  leadEmail: emailSchema,
  leadPhone: phoneSchema,
  members: z
    .array(teamMemberSchema, { required_error: 'Add at least one active team member.' })
    .min(1, 'Add at least one active team member.')
    .max(12, 'A team may have at most 12 members.'),
});

export const teamStepDraftSchema = teamStepSchema.deepPartial();

export type TeamStep = z.infer<typeof teamStepSchema>;

// --------------------------------------------------------------------------
// Step 2 — Product
// --------------------------------------------------------------------------

export const productStepSchema = z.object({
  ideaId: z.string({ required_error: 'Choose one approved product idea.' })
    .min(1, 'Choose one approved product idea.'),
  productName: shortText(80, 'Product name'),
  primaryUser: longText(10, 200, 'Primary user'),
  exactProblem: longText(30, 600, 'The exact problem'),
  oneSentencePromise: longText(15, 200, 'One-sentence promise'),
  briefDescription: longText(50, 1200, 'Brief description'),
  whyAiNecessary: longText(30, 800, 'Why AI is necessary'),
  differentiation: longText(30, 800, 'Differentiation'),
  /** The single must-have flow the team committed to — drives the test plan. */
  mustHaveWorkflow: longText(30, 800, 'Must-have workflow'),
  shouldHaveFeatures: z
    .array(trimmed(z.string().min(1).max(200)))
    .max(2, 'List at most two should-have features.')
    .default([]),
  excludedFeatures: longText(10, 600, 'Deliberately excluded features'),
});

export const productStepDraftSchema = productStepSchema.deepPartial();

export type ProductStep = z.infer<typeof productStepSchema>;

// --------------------------------------------------------------------------
// Step 3 — Live product
// --------------------------------------------------------------------------

export const testStepEntrySchema = z.object({
  action: longText(5, 300, 'Test step'),
  expectedResult: longText(5, 300, 'Expected result'),
});

export const liveProductStepSchema = z
  .object({
    productUrl: productUrlSchema,
    loginRequired: z.boolean({
      required_error: 'Say whether your product needs a login to use.',
      invalid_type_error: 'Say whether your product needs a login to use.',
    }),
    coreTestSteps: z
      .array(testStepEntrySchema, {
        required_error: 'Describe the steps a judge should follow to use your product.',
      })
      .min(2, 'Describe at least two steps so the judge can follow your core flow.')
      .max(15, 'Describe at most 15 steps — focus on the core flow.'),
    safeSampleInputs: longText(10, 800, 'Safe sample inputs'),
    resetInstructions: longText(10, 600, 'Reset or cleanup instructions'),
    knownLimitations: longText(10, 800, 'Known limitations'),

    // Conditional. Encrypted at rest; never sent to an AI provider.
    demoUsername: z.string().trim().max(200).optional(),
    demoPassword: z.string().max(200).optional(),
    loginInstructions: z.string().trim().max(1000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.loginRequired) {
      if (!value.demoUsername || value.demoUsername.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['demoUsername'],
          message: 'Because login is required, supply a working demo username.',
        });
      }
      if (!value.demoPassword || value.demoPassword.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['demoPassword'],
          message: 'Because login is required, supply a working demo password.',
        });
      }
    }
  });

export const liveProductStepDraftSchema = z.object({
  productUrl: z.string().trim().max(2000).optional(),
  loginRequired: z.boolean().optional(),
  coreTestSteps: z
    .array(z.object({ action: z.string().max(300).optional(), expectedResult: z.string().max(300).optional() }))
    .optional(),
  safeSampleInputs: z.string().max(800).optional(),
  resetInstructions: z.string().max(600).optional(),
  knownLimitations: z.string().max(800).optional(),
  demoUsername: z.string().max(200).optional(),
  demoPassword: z.string().max(200).optional(),
  loginInstructions: z.string().max(1000).optional(),
});

export type LiveProductStep = z.infer<typeof liveProductStepSchema>;

/** Fields that must never be logged, serialised to the client, or sent to AI. */
export const CREDENTIAL_FIELDS = ['demoUsername', 'demoPassword', 'loginInstructions'] as const;

// --------------------------------------------------------------------------
// Step 4 — Artifacts
// --------------------------------------------------------------------------

export const MAX_DECK_BYTES = 25 * 1024 * 1024;
export const ALLOWED_DECK_MIME = 'application/pdf';

export const artifactsStepSchema = z.object({
  deckArtifactId: z
    .string({ required_error: 'Upload your pitch deck as a PDF.' })
    .min(1, 'Upload your pitch deck as a PDF.'),
  demoVideoUrl: demoVideoUrlSchema,
  demoUnderThreeMinutes: z.literal(true, {
    errorMap: () => ({ message: 'Confirm that your demo video is three minutes or shorter.' }),
  }),
  transcriptArtifactId: z.string().optional(),
  screenshotArtifactIds: z.array(z.string()).max(10).default([]),
});

export const artifactsStepDraftSchema = z.object({
  deckArtifactId: z.string().optional(),
  demoVideoUrl: z.string().max(2000).optional(),
  demoUnderThreeMinutes: z.boolean().optional(),
  transcriptArtifactId: z.string().optional(),
  screenshotArtifactIds: z.array(z.string()).max(10).optional(),
});

export type ArtifactsStep = z.infer<typeof artifactsStepSchema>;

/** Upload validation — MIME, extension, size, and completion all checked. */
export interface UploadValidationResult {
  ok: boolean;
  message?: string;
}

export function validateDeckUpload(file: {
  name: string;
  type: string;
  size: number;
}): UploadValidationResult {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    return { ok: false, message: 'The pitch deck must be a .pdf file.' };
  }
  if (file.type !== ALLOWED_DECK_MIME) {
    return { ok: false, message: `The pitch deck must be a PDF (received ${file.type || 'unknown type'}).` };
  }
  if (file.size <= 0) {
    return { ok: false, message: 'The uploaded file is empty.' };
  }
  if (file.size > MAX_DECK_BYTES) {
    return {
      ok: false,
      message: `The pitch deck must be ${Math.round(MAX_DECK_BYTES / 1024 / 1024)} MB or smaller.`,
    };
  }
  return { ok: true };
}

/** PDF magic bytes — checked server-side, because a client MIME type is a claim. */
export function looksLikePdf(head: Uint8Array): boolean {
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
}

// --------------------------------------------------------------------------
// Step 5 — Learning evidence
// --------------------------------------------------------------------------

export const bugFixedSchema = z.object({
  description: longText(15, 400, 'A bug description'),
  howFixed: longText(10, 400, 'A description of how the bug was fixed'),
});

export const learningStepSchema = z.object({
  bugsFixed: z
    .array(bugFixedSchema, {
      required_error: 'Describe exactly three important bugs you found and fixed.',
    })
    .length(3, 'Describe exactly three important bugs you found and fixed.'),
  deliberatelyExcluded: longText(15, 500, 'Deliberately excluded feature'),
  majorTradeoff: longText(20, 600, 'Major trade-off'),
  day12ToDay13Changes: longText(20, 800, 'What changed from Day 12 to Day 13'),
  mostImportantLearning: longText(20, 600, 'Most important learning'),
  nextSevenDayPlan: longText(20, 800, 'Next seven-day plan'),
  builderStack: shortText(300, 'Builder / stack used'),
  apisUsed: z.string().trim().max(500).default(''),
  externalTemplates: z.string().trim().max(500).default(''),
});

export const learningStepDraftSchema = z.object({
  bugsFixed: z
    .array(z.object({ description: z.string().max(400).optional(), howFixed: z.string().max(400).optional() }))
    .optional(),
  deliberatelyExcluded: z.string().max(500).optional(),
  majorTradeoff: z.string().max(600).optional(),
  day12ToDay13Changes: z.string().max(800).optional(),
  mostImportantLearning: z.string().max(600).optional(),
  nextSevenDayPlan: z.string().max(800).optional(),
  builderStack: z.string().max(300).optional(),
  apisUsed: z.string().max(500).optional(),
  externalTemplates: z.string().max(500).optional(),
});

export type LearningStep = z.infer<typeof learningStepSchema>;

// --------------------------------------------------------------------------
// Step 6 — Declarations
// --------------------------------------------------------------------------

export const DECLARATION_KEYS = [
  'builtDuringHackathon',
  'ownedByTeam',
  'externalMaterialDisclosed',
  'judgeMayModifyDemoData',
  'noRealCustomerData',
  'urlsAvailableThroughJudging',
  'permissionToSubmit',
] as const;

export type DeclarationKey = (typeof DECLARATION_KEYS)[number];

export const DECLARATION_TEXT: Record<DeclarationKey, string> = {
  builtDuringHackathon:
    'This product was built during the hackathon on Days 12 and 13 of the accelerator.',
  ownedByTeam: 'This work belongs to our team and we have the right to submit it.',
  externalMaterialDisclosed:
    'We have disclosed any external templates, starter code, APIs and third-party material we used.',
  judgeMayModifyDemoData:
    'We consent to an automated judge creating, editing and deleting demo data inside our product while it is assessed.',
  noRealCustomerData:
    'Our product contains no real customer data and no sensitive personal information.',
  urlsAvailableThroughJudging:
    'The URLs we have submitted will stay available and working throughout the judging period.',
  permissionToSubmit:
    'We have permission from everyone involved to submit these materials for assessment.',
};

const requiredDeclaration = (key: DeclarationKey) =>
  z.literal(true, {
    errorMap: () => ({ message: `You must agree: "${DECLARATION_TEXT[key]}"` }),
  });

export const declarationsStepSchema = z.object({
  builtDuringHackathon: requiredDeclaration('builtDuringHackathon'),
  ownedByTeam: requiredDeclaration('ownedByTeam'),
  externalMaterialDisclosed: requiredDeclaration('externalMaterialDisclosed'),
  judgeMayModifyDemoData: requiredDeclaration('judgeMayModifyDemoData'),
  noRealCustomerData: requiredDeclaration('noRealCustomerData'),
  urlsAvailableThroughJudging: requiredDeclaration('urlsAvailableThroughJudging'),
  permissionToSubmit: requiredDeclaration('permissionToSubmit'),
});

export const declarationsStepDraftSchema = z.object(
  Object.fromEntries(DECLARATION_KEYS.map((k) => [k, z.boolean().optional()])) as Record<
    DeclarationKey,
    z.ZodOptional<z.ZodBoolean>
  >,
);

export type DeclarationsStep = z.infer<typeof declarationsStepSchema>;

// --------------------------------------------------------------------------
// Whole submission
// --------------------------------------------------------------------------

export const SUBMISSION_STEPS = [
  'team',
  'product',
  'live',
  'artifacts',
  'learning',
  'declarations',
] as const;
export type SubmissionStepKey = (typeof SUBMISSION_STEPS)[number];

export const SUBMISSION_STEP_LABELS: Record<SubmissionStepKey, string> = {
  team: 'Team',
  product: 'Product idea',
  live: 'Live product',
  artifacts: 'Demo and deck',
  learning: 'Learning evidence',
  declarations: 'Declarations',
};

/**
 * One line explaining what each step is for, shown at the top of the step.
 *
 * Written for a participant under time pressure: what to do, not what the field
 * is called.
 */
export const SUBMISSION_STEP_INTROS: Record<SubmissionStepKey, string> = {
  team: 'Confirm the people who actively built this submission.',
  product: 'Select the approved challenge and describe the problem and product promise.',
  live: 'Tell the automated judge how to safely access and test your core workflow.',
  artifacts: 'Upload the final pitch deck and link the short product walkthrough.',
  learning: 'Show how your team scoped, tested and improved the product during the hackathon.',
  declarations: 'Confirm the rules your submission is entered under.',
};

export const fullSubmissionSchema = z.object({
  team: teamStepSchema,
  product: productStepSchema,
  live: liveProductStepSchema,
  artifacts: artifactsStepSchema,
  learning: learningStepSchema,
  declarations: declarationsStepSchema,
});

export const draftSubmissionSchema = z.object({
  team: teamStepDraftSchema.optional(),
  product: productStepDraftSchema.optional(),
  live: liveProductStepDraftSchema.optional(),
  artifacts: artifactsStepDraftSchema.optional(),
  learning: learningStepDraftSchema.optional(),
  declarations: declarationsStepDraftSchema.optional(),
});

export type FullSubmission = z.infer<typeof fullSubmissionSchema>;
export type DraftSubmission = z.infer<typeof draftSubmissionSchema>;

export const stepSchemas = {
  team: teamStepSchema,
  product: productStepSchema,
  live: liveProductStepSchema,
  artifacts: artifactsStepSchema,
  learning: learningStepSchema,
  declarations: declarationsStepSchema,
} as const;

export const draftStepSchemas = {
  team: teamStepDraftSchema,
  product: productStepDraftSchema,
  live: liveProductStepDraftSchema,
  artifacts: artifactsStepDraftSchema,
  learning: learningStepDraftSchema,
  declarations: declarationsStepDraftSchema,
} as const;

// --------------------------------------------------------------------------
// Completeness reporting
// --------------------------------------------------------------------------

export interface StepCompleteness {
  step: SubmissionStepKey;
  label: string;
  complete: boolean;
  /** Field-path → message, so the review screen can link to the exact field. */
  issues: { path: string; message: string }[];
}

export interface SubmissionCompleteness {
  complete: boolean;
  steps: StepCompleteness[];
  totalIssues: number;
}

/**
 * Evaluate the whole draft against strict schemas.
 *
 * Drives the review screen: teams see exactly which fields block Final Submit,
 * rather than a single "form invalid" message. This is what replaces the
 * historical pattern of malformed submissions arriving because nothing checked
 * them until a human opened them days later.
 */
export function evaluateCompleteness(draft: unknown): SubmissionCompleteness {
  const value = (draft ?? {}) as Record<string, unknown>;
  const steps: StepCompleteness[] = SUBMISSION_STEPS.map((step) => {
    const result = stepSchemas[step].safeParse(value[step] ?? {});
    if (result.success) {
      return { step, label: SUBMISSION_STEP_LABELS[step], complete: true, issues: [] };
    }
    return {
      step,
      label: SUBMISSION_STEP_LABELS[step],
      complete: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: humaniseIssue(issue.path, issue.message),
      })),
    };
  });

  const totalIssues = steps.reduce((sum, s) => sum + s.issues.length, 0);
  return { complete: steps.every((s) => s.complete), steps, totalIssues };
}

/**
 * Turn a schema complaint into something a learner can act on.
 *
 * Zod's defaults are written for whoever wrote the schema: a missing field
 * reports `Required`, and a null reports `Expected string, received null`.
 * Shown on a submission form at 23:50 those say nothing about which answer is
 * missing or what to do about it.
 *
 * Most fields carry their own message. This is the catch-all, so a field added
 * later cannot leak raw schema text to a learner by being forgotten.
 */
export function humaniseIssue(path: (string | number)[], message: string): string {
  const looksRaw =
    /^required$/i.test(message) ||
    /^expected .+, received/i.test(message) ||
    /^invalid input$/i.test(message) ||
    /^invalid_type/i.test(message);

  if (!looksRaw) return message;

  const field = fieldLabel(path);
  return field ? `${field} is required.` : 'This answer is required.';
}

/** `live.coreTestSteps.0.action` → "Action". Indexes and step prefixes are noise to a learner. */
function fieldLabel(path: (string | number)[]): string | null {
  const named = path.filter((part): part is string => typeof part === 'string');
  const last = named[named.length - 1];
  if (!last) return null;

  const spaced = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .toLowerCase();

  const sentence = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  // Abbreviations that look wrong in sentence case.
  return sentence.replace(/\burl\b/gi, 'URL').replace(/\bai\b/gi, 'AI');
}

/** The exact phrase a team must type to submit. Case-sensitive by design. */
export const FINAL_SUBMIT_CONFIRMATION = 'FINAL SUBMIT';

export const finalSubmitSchema = z.object({
  confirmation: z.literal(FINAL_SUBMIT_CONFIRMATION, {
    errorMap: () => ({ message: `Type ${FINAL_SUBMIT_CONFIRMATION} exactly to confirm.` }),
  }),
});
