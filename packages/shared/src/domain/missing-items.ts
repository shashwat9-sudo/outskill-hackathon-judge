/**
 * "What's missing?" — the gap between a draft and a submission, in a learner's words.
 *
 * `evaluateCompleteness` already knows exactly what is unfinished, but it
 * answers in the vocabulary of the schema: paths, minimum lengths, `Required`.
 * That is the correct output for a validator and the wrong thing to show
 * someone at 23:40 who wants to know what to type next.
 *
 * This turns it into a list of things to do, each one pointing at the field
 * that fixes it. No path, no character count without a translation, and no
 * message that arrived unedited from Zod: every required question carries its
 * own to-do phrasing, and anything without one falls back to a sentence written
 * here rather than leaking the schema's.
 *
 * Read-only. It takes a completeness report and returns a list; nothing in this
 * module can write.
 */

import {
  DECLARATION_KEYS,
  type DeclarationKey,
  type StepCompleteness,
  type SubmissionCompleteness,
  type SubmissionStepKey,
} from '../schemas/submission';
import {
  REPEATED_GROUP_NOUN,
  SCHEMA_STEP_TO_LEARNER_STEP,
  fieldGuide,
  requirementLine,
  stripIndices,
  type LearnerStepKey,
} from '../content/learner-guidance';

/**
 * The seven declarations, as things to tick.
 *
 * The declaration text itself is a full legal-ish sentence — accurate, and too
 * long for a to-do list. These name the topic instead; the sentence is right
 * next to the checkbox when the learner arrives.
 */
export const DECLARATION_MISSING: Record<DeclarationKey, string> = {
  builtDuringHackathon: 'Confirm you built this during the hackathon',
  ownedByTeam: 'Confirm the work belongs to your team',
  externalMaterialDisclosed: 'Confirm you have listed any templates or external material you used',
  judgeMayModifyDemoData: 'Allow us to create and delete demo data while testing',
  noRealCustomerData: 'Confirm your product holds no real customer data',
  urlsAvailableThroughJudging: 'Confirm your links will keep working during judging',
  permissionToSubmit: 'Confirm everyone involved agreed to this submission',
};

export interface MissingItem {
  /** The step to send the learner to. */
  step: LearnerStepKey;
  /** Which schema step raised it — kept so counts can be checked against the validator. */
  schemaStep: SubmissionStepKey;
  /** The schema path, indices intact. */
  path: string;
  /** What to do, in plain English. */
  text: string;
  /** The rule, where stating it helps. Never a raw schema message. */
  detail?: string;
  /** The id of the control that fixes it, so the list can be clicked. */
  fieldId: string;
}

export interface MissingSummary {
  total: number;
  items: MissingItem[];
  /** Items grouped by the step that owns them, for per-step panels. */
  byStep: Record<LearnerStepKey, MissingItem[]>;
}

/**
 * The DOM id of the control for a path.
 *
 * Derived rather than mapped, so the form and this list cannot disagree about
 * where a thing lives. The form uses the same function to label its fields;
 * `learner-guidance.spec.ts` clicks the result in a real browser, which is the
 * only check that actually proves the two ends meet.
 *
 *   product.primaryUser        → primaryUser
 *   learning.bugsFixed.2.howFixed → bugsFixed-2-howFixed
 */
export function fieldDomId(path: string): string {
  return path.split('.').slice(1).join('-') || path;
}

/**
 * One to-do per unfinished thing.
 *
 * Deduplicated by path: a field can raise two issues at once (missing *and*
 * too short, once someone types a single character), and "Tell us who your
 * product is for" twice in a list of four is both wrong and alarming.
 */
export function collectMissingItems(completeness: SubmissionCompleteness): MissingSummary {
  const items: MissingItem[] = [];
  const seen = new Set<string>();

  for (const step of completeness.steps) {
    for (const item of stepMissingItems(step)) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      items.push(item);
    }
  }

  const byStep = {
    team: [],
    product: [],
    live: [],
    artifacts: [],
    learning: [],
    review: [],
  } as Record<LearnerStepKey, MissingItem[]>;

  for (const item of items) byStep[item.step].push(item);

  return { total: items.length, items, byStep };
}

/** Everything unfinished in one schema step. */
export function stepMissingItems(step: StepCompleteness): MissingItem[] {
  if (step.complete) return [];

  const learnerStep = SCHEMA_STEP_TO_LEARNER_STEP[step.step];

  return step.issues.map((issue) => {
    const path = issue.path ? `${step.step}.${issue.path}` : step.step;
    return {
      step: learnerStep,
      schemaStep: step.step,
      path,
      text: describe(step.step, issue.path, path),
      detail: detailFor(path),
      fieldId: fieldDomId(path),
    };
  });
}

/**
 * What to do about one issue.
 *
 * Three sources, in order of how well they read: the question's own to-do
 * phrasing, the declaration list, and — for anything not covered, including a
 * field added after this was written — a sentence built from the field name.
 * The last one is deliberately dull, because the alternative is a learner
 * reading `Expected string, received null`.
 */
function describe(schemaStep: SubmissionStepKey, issuePath: string, fullPath: string): string {
  if (schemaStep === 'declarations') {
    const key = issuePath.split('.')[0] as DeclarationKey;
    if (DECLARATION_KEYS.includes(key)) return DECLARATION_MISSING[key];
    return 'Agree to all seven declarations';
  }

  const guide = fieldGuide(fullPath);
  const prefix = groupPrefix(fullPath);

  if (guide?.missing) {
    return prefix ? `${prefix} — ${lowerFirst(guide.missing)}` : guide.missing;
  }
  if (guide?.label) {
    return prefix ? `${prefix} — ${lowerFirst(guide.label)}` : guide.label;
  }

  const name = readableFieldName(fullPath);
  return name ? `Add ${name}` : 'Finish this answer';
}

/** "Bug 2" / "Step 1" / "Member 3" for a field inside a repeated group. */
function groupPrefix(path: string): string | null {
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d+$/.test(parts[i]!)) continue;
    const groupPath = parts.slice(0, i).join('.');
    const noun = REPEATED_GROUP_NOUN[groupPath];
    if (noun) return `${noun} ${Number(parts[i]) + 1}`;
  }
  return null;
}

/** The requirement, so someone can see what "enough" means without failing first. */
function detailFor(path: string): string | undefined {
  const guide = fieldGuide(path);
  if (!guide) return undefined;
  const line = requirementLine(guide);
  // "Optional." under a thing that is blocking submission would be nonsense.
  return line === 'Optional.' ? undefined : line;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** `product.someNewField` → "some new field". A last resort, but a readable one. */
function readableFieldName(path: string): string | null {
  const last = stripIndices(path).split('.').pop();
  if (!last) return null;
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\burl\b/g, 'URL')
    .replace(/\bai\b/g, 'AI');
}

/**
 * The one-line summary above the list: "2 things left".
 *
 * Singular and plural both written out — "1 things left" is the kind of detail
 * that makes a learner trust the rest of the screen slightly less.
 */
export function missingSummaryLabel(count: number): string {
  if (count === 0) return 'Nothing left';
  return count === 1 ? '1 thing left' : `${count} things left`;
}
