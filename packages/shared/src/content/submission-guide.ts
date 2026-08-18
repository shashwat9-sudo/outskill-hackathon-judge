/**
 * The two-day submission guide.
 *
 * One source of truth for both the web page and the downloadable PDF. Two
 * copies of this content would drift within a week, and a team reading the PDF
 * would be working to different instructions from a team reading the page.
 *
 * Written for someone with roughly thirty-six hours and a half-built product.
 * It is deliberately about what to *do*, and deliberately silent about how
 * things are scored beyond the public category weights — assessment detail is
 * internal (ADR-011), and telling teams how to optimise against a rubric would
 * change what they build for the worse.
 */

import type { DocBlock } from '../domain/document-pdf';
import {
  COMMON_MISTAKES,
  FIELD_GUIDANCE,
  FINAL_SUBMIT_EXPLANATION,
  LEARNER_STEPS,
  STEP_GUIDANCE,
} from './learner-guidance';

export interface GuideSection {
  id: string;
  title: string;
  /** Shown under the heading on the web page. */
  intro?: string;
  items: GuideItem[];
}

export interface GuideItem {
  kind: 'step' | 'point' | 'warning';
  text: string;
  /**
   * A worked question and answer, read from the same guidance the form shows.
   *
   * Not written out here. A team reading the guide and a team reading the form
   * must be looking at the same sentence, and the only way to guarantee that is
   * for there to be one sentence.
   */
  example?: { question: string; answer: string };
}

/** The worked example shown against a step in the guide, where one helps. */
const STEP_EXAMPLE_FIELD: Partial<Record<(typeof LEARNER_STEPS)[number], string>> = {
  product: 'product.exactProblem',
  live: 'live.knownLimitations',
  learning: 'learning.mostImportantLearning',
};

/**
 * The six steps, expanded.
 *
 * Each step becomes a numbered entry saying what it asks for, the things to
 * have ready before starting it, and — for the three that teams most often
 * misread — one worked answer.
 */
function sixStepItems(): GuideItem[] {
  const items: GuideItem[] = [];

  for (const step of LEARNER_STEPS) {
    const guide = STEP_GUIDANCE[step];
    const exampleField = STEP_EXAMPLE_FIELD[step];
    const field = exampleField ? FIELD_GUIDANCE[exampleField] : undefined;

    items.push({
      kind: 'step',
      text: `${guide.label}. ${guide.intro}`,
      ...(field?.example ? { example: { question: field.label, answer: field.example } } : {}),
    });

    for (const prepare of guide.prepare ?? []) {
      items.push({ kind: 'point', text: `Have ready: ${prepare}` });
    }
  }

  return items;
}

export interface SubmissionGuide {
  title: string;
  subtitle: string;
  sections: GuideSection[];
}

/**
 * Build the guide.
 *
 * Deadline and cohort name are injected rather than hard-coded, so the same
 * guide serves every cohort and nobody has to remember to edit a date.
 */
export function buildSubmissionGuide(input: {
  cohortName: string;
  deadlineLabel: string;
  submitUrl: string;
}): SubmissionGuide {
  return {
    title: 'Your two days: Day 12 and Day 13',
    subtitle: `${input.cohortName} · submissions close ${input.deadlineLabel}`,
    sections: [
      {
        id: 'shape',
        title: 'What the two days look like',
        intro:
          'You have roughly thirty-six hours. The teams who finish comfortably are not the fastest builders — they are the ones who decided early what they were not going to build.',
        items: [
          {
            kind: 'step',
            text: 'Day 12 morning: pick your idea from the approved list and write down the single workflow your product must do end to end. One workflow, not three.',
          },
          {
            kind: 'step',
            text: 'Day 12 afternoon and evening: build that one workflow until it works from a fresh browser, on a URL that is not localhost.',
          },
          {
            kind: 'step',
            text: 'Day 13 morning: fix what breaks when someone else uses it. Watch a teammate try it without helping them.',
          },
          {
            kind: 'step',
            text: 'Day 13 afternoon: record the demo, export the deck, fill in the submission form. Leave two hours for this — it always takes longer than teams expect.',
          },
          {
            kind: 'warning',
            text: 'Do not leave the submission itself to the last hour. Save as you go: your entry is stored every few seconds, and you can come back to it as often as you like.',
          },
        ],
      },
      {
        id: 'steps',
        title: 'The six steps',
        intro:
          'The form asks six things. None of them needs a long answer — a clear sentence beats a paragraph, every time. You can see all of this filled in for a made-up project at /submit/example.',
        items: sixStepItems(),
      },
      {
        id: 'live',
        title: 'Your live product',
        intro:
          'This is the part that is actually tested. A product that cannot be reached is the single most common way a team throws away work it had already done.',
        items: [
          {
            kind: 'point',
            text: 'Deploy somewhere public. Vercel, Netlify, Render, Railway, Replit — anything with a real URL. A localhost address, an IP on your own network, or a tunnel you close on Day 13 will all fail.',
          },
          {
            kind: 'point',
            text: 'Open your URL on your phone, on mobile data, with your laptop closed. If it loads there, it will load for us.',
          },
          {
            kind: 'point',
            text: 'Keep it running until you hear from Outskill about outcomes. Taking it down the day after you submit means it cannot be assessed.',
          },
          {
            kind: 'point',
            text: 'If your product needs a login, create a demo account for the judges and give us those details in the form. Never give us a real account, and never use real customer data anywhere in your demo.',
          },
          {
            kind: 'point',
            text: 'Write the exact steps someone should follow to see your product work — the same steps you would use if you were showing it to a friend over a video call.',
          },
        ],
      },
      {
        id: 'deck',
        title: 'Your pitch deck',
        items: [
          {
            kind: 'point',
            text: 'Export it as a PDF. Not a link to Google Slides, Canva or Figma — a PDF file you upload.',
          },
          {
            kind: 'point',
            text: 'Keep it under 20 MB and under about fifteen slides. Nobody has ever been marked down for brevity.',
          },
          {
            kind: 'point',
            text: 'Cover: who it is for, the problem, what your product does, why AI is genuinely needed for it, and what you would build next.',
          },
        ],
      },
      {
        id: 'demo',
        title: 'Your demo video',
        items: [
          {
            kind: 'point',
            text: 'Under three minutes. Show the workflow working — do not spend the first minute on slides.',
          },
          {
            kind: 'point',
            text: 'Upload it anywhere with a shareable link: YouTube (unlisted is fine), Loom, Drive, Vimeo.',
          },
          {
            kind: 'warning',
            text: 'Check the sharing setting from a private browser window. "Anyone with the link can view" is the setting you want. A link only you can open is the same as no link.',
          },
        ],
      },
      {
        id: 'evidence',
        title: 'What you learned',
        intro:
          'The form asks what broke, what you cut, and what you would do next. This is not a formality — it is where a team that built something modest and understood it well can show that clearly.',
        items: [
          {
            kind: 'point',
            text: 'Be specific about bugs you fixed. "Fixed the date parser that broke on the first of the month" says more than "fixed several bugs".',
          },
          {
            kind: 'point',
            text: 'Be honest about what you left out and why. Deliberately cutting scope is a decision, and saying so is better than pretending it was finished.',
          },
          {
            kind: 'point',
            text: 'Declare anything you did not build yourself: templates, starter kits, generated code, external APIs. Disclosure is expected and costs you nothing. Not disclosing is treated seriously.',
          },
        ],
      },
      {
        id: 'submitting',
        title: 'Submitting',
        items: [
          {
            kind: 'step',
            text: `Go to ${input.submitUrl} and enter your group number and team access code.`,
          },
          {
            kind: 'step',
            text: 'Add your name so your team can see who changed what. Any member with the code can edit, and everyone edits the same entry.',
          },
          {
            kind: 'step',
            text: 'Work through the six steps. Your progress saves automatically; you do not need to finish in one sitting.',
          },
          {
            kind: 'step',
            text: 'On the last step, review everything and press Final Submit. You will get an on-screen receipt and a PDF you can download.',
          },
          {
            kind: 'warning',
            text: `${FINAL_SUBMIT_EXPLANATION.body} If something is genuinely wrong afterwards, contact the Outskill team — they can reopen it, and you will see it become editable again.`,
          },
          {
            kind: 'warning',
            text: `Submissions close ${input.deadlineLabel}. The deadline is enforced by the clock on our server, not yours.`,
          },
        ],
      },
      {
        id: 'mistakes',
        title: 'Mistakes that cost teams marks',
        intro:
          'None of these are about how good your product is. Every one of them is a team losing marks for something they had already done.',
        items: COMMON_MISTAKES.map((text) => ({ kind: 'point' as const, text })),
      },
      {
        id: 'help',
        title: 'If something goes wrong',
        items: [
          {
            kind: 'point',
            text: 'Wrong code eight times in a row locks your team out for fifteen minutes. Tell the Outskill team and they can clear it straight away.',
          },
          {
            kind: 'point',
            text: 'If a teammate saves while you are editing, you will be told and shown their version. Nothing is lost silently.',
          },
          {
            kind: 'point',
            text: 'Lost your access code? It cannot be looked up — not even by Outskill. They will issue your team a new one.',
          },
        ],
      },
    ],
  };
}

/** Render the guide as PDF blocks. */
export function guideToBlocks(guide: SubmissionGuide): DocBlock[] {
  const blocks: DocBlock[] = [
    { type: 'title', text: guide.title },
    { type: 'subtitle', text: guide.subtitle },
    { type: 'rule' },
  ];

  for (const section of guide.sections) {
    blocks.push({ type: 'heading', text: section.title });
    if (section.intro) blocks.push({ type: 'paragraph', text: section.intro });

    let stepNumber = 0;
    for (const item of section.items) {
      if (item.kind === 'step') {
        stepNumber += 1;
        blocks.push({ type: 'numbered', index: stepNumber, text: item.text });
      } else if (item.kind === 'warning') {
        blocks.push({ type: 'callout', text: item.text });
      } else {
        blocks.push({ type: 'bullet', text: item.text });
      }

      // The worked answer, right under the thing it illustrates. Marked as an
      // example in the text itself, because a PDF has no styling a reader can
      // hover over to find out what a quoted line is doing there.
      if (item.example) {
        blocks.push({
          type: 'bullet',
          text: `Example — ${item.example.question} “${item.example.answer}”`,
        });
      }
    }
  }

  blocks.push({ type: 'spacer' });
  blocks.push({ type: 'rule' });
  blocks.push({
    type: 'paragraph',
    text: 'Assessment results are internal to Outskill and are not shared with participants.',
  });

  return blocks;
}
