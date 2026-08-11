/**
 * Generates the internal demo deck.
 *
 * Produces a self-contained HTML deck in black, white and Outskill green, plus
 * a Markdown version for anyone who wants the words without the slides.
 *
 * HTML rather than PPTX on purpose: no binary dependency, it opens anywhere,
 * it prints to PDF cleanly, and the colour tokens stay in one place so swapping
 * in the real brand green is a one-line change (ADR-014).
 *
 * Run with: npm run gen:deck
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { BRAND, DECK_PALETTE, RUBRIC_CATEGORIES } from '../packages/shared/src/index';

interface Slide {
  title: string;
  kicker?: string;
  body?: string;
  bullets?: string[];
  table?: { headers: string[]; rows: (string | number)[][] };
  note?: string;
}

const SLIDES: Slide[] = [
  {
    kicker: 'Outskill · Internal',
    title: 'Hackathon Judge',
    body: 'Evidence-backed assessment for 300–500 hackathon submissions, in the ten hours between the deadline and the shortlist.',
  },
  {
    kicker: '01',
    title: 'The problem with judging by hand',
    bullets: [
      'A Google Form produces submissions nobody validated — decks that are actually Loom links, credentials pasted into URL fields, links that were never reachable.',
      'External mentors each open a few products, form an impression, and write freehand feedback. Coverage is uneven and standards drift between reviewers.',
      'Nobody actually exercises the product deeply. There is no time.',
      'Scores and notes are collated by hand across spreadsheets and chat.',
      'Ten hours between the Day 13 deadline and the Day 14 shortlist. It only works because reviewers cut depth.',
    ],
  },
  {
    kicker: '02',
    title: 'What we built',
    body: 'A platform that takes a submission from intake to a defensible private ranking — where "evidence" means a real browser actually drove the product.',
    bullets: [
      'Structured intake that makes the historical data-quality failures impossible',
      'Automated preflight, artifact analysis and product-specific test planning',
      'Deep Playwright testing of the live product',
      'Evidence-backed scores against a fixed 100-point rubric',
      'Private ranking and a private top 10',
      'Humans choose the final four',
    ],
  },
  {
    kicker: '03',
    title: 'The participant journey',
    bullets: [
      'One secure invite link per team. No account, no password, no signup.',
      'Six autosaving steps: team, product, live product, artifacts, learning evidence, declarations.',
      'The form asks for what teams already wrote in their workbook — the MoSCoW scope, the bug log, the reflection.',
      'A review screen shows exactly what is missing, field by field.',
      'Typed FINAL SUBMIT locks the submission and issues a receipt.',
      'Participants see the rubric and the deadline. They never see a score, a rank, or a shortlist.',
    ],
  },
  {
    kicker: '04',
    title: 'The assessment pipeline',
    table: {
      headers: ['Stage', 'What happens'],
      rows: [
        ['preflight', '13 checks; every attempt recorded; outage told apart from absence'],
        ['artifact_analysis', 'Deck text, written submission, injection screening'],
        ['test_plan_generation', 'A product-specific plan, constrained to a closed action set'],
        ['browser_testing', 'Real Chromium drives the live product'],
        ['evidence_review', 'Evidence assembled per rubric category'],
        ['scoring', 'Eight categories, each with evidence and confidence'],
        ['consistency_review', 'Second pass only where it could change an outcome'],
        ['completed', 'Ranked, if eligible'],
      ],
    },
    note: 'manual_review, failed and disqualified are outcomes, not errors.',
  },
  {
    kicker: '05',
    title: 'Deep testing, not a screenshot',
    bullets: [
      'A fresh isolated browser per submission, eight-minute budget, downloads disabled.',
      'Runs the team’s own declared must-have workflow — twice, because that is the stability bar they were taught.',
      'Proves persistence by reloading and checking the data survived.',
      'Captures console errors, failed requests, dead ends, an accessibility scan, and a mobile pass.',
      'Everything it creates is prefixed OUTSKILL-JUDGE- and cleaned up afterwards.',
      'Test plans are data, never code. There is no action that can execute anything.',
    ],
  },
  {
    kicker: '06',
    title: 'The rubric',
    table: {
      headers: ['Category', 'Points'],
      rows: [
        ...RUBRIC_CATEGORIES.map((c) => [c.title, c.maxPoints] as [string, number]),
        ['Total', 100],
      ],
    },
    note: 'Fixed and public. The test scripts, thresholds and tie-break rules are not.',
  },
  {
    kicker: '07',
    title: 'Every score carries its evidence',
    bullets: [
      'Supporting evidence — what was actually observed.',
      'Contradictory evidence — where the product disagreed with the claim.',
      'Missing evidence — what could not be checked, stated plainly.',
      'Confidence 0–1, about how much there was to go on, not how good the product is.',
      'Observed browser evidence outweighs any unsupported deck claim.',
      'A run that timed out says so. Unreached steps are unknown, not failed.',
    ],
    note: 'A category with no evidence is flagged as unsupported rather than quietly scored.',
  },
  {
    kicker: '08',
    title: 'Private top 10. Human final four.',
    bullets: [
      'Eligible submissions are ranked; ties break on core workflow, then stability, then AI usefulness, then learning, then fewer unresolved risks.',
      'Ranking snapshots are immutable, so the ranking a decision was made against stays reconstructable.',
      'The top 10 is highlighted privately, for reviewers only.',
      'Admins review evidence, override with a reason, and the machine’s original score is preserved.',
      'The final four are chosen by a person, in one place, with a recorded reason each.',
      'No worker, no job stage and no model response can write a winner.',
    ],
  },
  {
    kicker: '09',
    title: 'Privacy and safety',
    bullets: [
      'Participants cannot reach judging data — the capability is absent, not merely hidden.',
      'Demo credentials are encrypted at rest, masked in the UI, and never sent to an AI model.',
      'PII is redacted before any model call; providers see an anonymised submission ID.',
      'The worker cannot reach private networks — resolved addresses are checked before every navigation.',
      'Prompt injection cannot change behaviour, because behaviour comes from validated structure, not prose.',
      'Disqualification is limited to eleven grounds. "Low score" is not one, and the database will not store it.',
    ],
  },
  {
    kicker: '10',
    title: 'The night it matters',
    table: {
      headers: ['Time (IST)', 'What happens'],
      rows: [
        ['11:59 PM Day 13', 'Deadline. Cohort closed.'],
        ['12:00 AM', 'Judging queued. Worker started.'],
        ['12:30 AM', 'First checkpoint — is the projection green?'],
        ['2:00–5:00 AM', 'Monitored run. Flags triaged as they appear.'],
        ['6:00 AM', 'Assessment complete. Manual reviews cleared.'],
        ['7:00 AM', 'Ranking snapshot. Second scoring pass.'],
        ['7:30–9:00 AM', 'Humans read the evidence for the top 10.'],
        ['9:00–9:45 AM', 'Final four chosen, with reasons.'],
        ['10:00 AM Day 14', 'Private shortlist ready.'],
      ],
    },
    note: 'Nothing is announced automatically. Announcement is a separate human act.',
  },
];

function renderSlide(slide: Slide, index: number): string {
  const parts: string[] = [];

  if (slide.kicker) parts.push(`<p class="kicker">${escapeHtml(slide.kicker)}</p>`);
  parts.push(`<h2>${escapeHtml(slide.title)}</h2>`);
  if (slide.body) parts.push(`<p class="lede">${escapeHtml(slide.body)}</p>`);

  if (slide.bullets) {
    parts.push(`<ul>${slide.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`);
  }

  if (slide.table) {
    const head = slide.table.headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('');
    const body = slide.table.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`)
      .join('');
    parts.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
  }

  if (slide.note) parts.push(`<p class="note">${escapeHtml(slide.note)}</p>`);

  return `<section class="slide${index === 0 ? ' title-slide' : ''}" aria-label="Slide ${index + 1}">
  <div class="slide-inner">${parts.join('\n    ')}</div>
  <p class="page-number" aria-hidden="true">${index + 1} / ${SLIDES.length}</p>
</section>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDeck(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outskill Hackathon Judge — internal briefing</title>
<style>
  :root {
    --bg: ${DECK_PALETTE.background};
    --surface: ${DECK_PALETTE.surface};
    --text: ${DECK_PALETTE.text};
    --muted: ${DECK_PALETTE.textMuted};
    --accent: ${DECK_PALETTE.accent};
    --accent-deep: ${DECK_PALETTE.accentDeep};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.5;
  }
  .slide {
    position: relative;
    min-height: 100vh;
    display: flex;
    align-items: center;
    padding: 4rem;
    border-bottom: 1px solid rgba(255,255,255,.12);
    page-break-after: always;
  }
  .slide-inner { max-width: 60rem; width: 100%; margin: 0 auto; }
  .title-slide h2 { font-size: clamp(3rem, 8vw, 5.5rem); }
  .title-slide { background: linear-gradient(160deg, var(--bg) 55%, var(--accent-deep) 100%); }
  .kicker {
    color: var(--accent);
    font-size: .8rem;
    font-weight: 700;
    letter-spacing: .18em;
    text-transform: uppercase;
    margin: 0 0 .75rem;
  }
  h2 { font-size: clamp(1.9rem, 4.5vw, 3rem); line-height: 1.1; margin: 0 0 1.25rem; letter-spacing: -.02em; }
  .lede { font-size: clamp(1.05rem, 2vw, 1.4rem); color: var(--muted); max-width: 48rem; margin: 0 0 1.5rem; }
  ul { margin: 0; padding: 0; list-style: none; }
  li {
    position: relative;
    padding-left: 1.75rem;
    margin-bottom: .9rem;
    font-size: clamp(.98rem, 1.6vw, 1.15rem);
    max-width: 52rem;
  }
  li::before {
    content: '';
    position: absolute;
    left: 0; top: .55em;
    width: .6rem; height: .6rem;
    background: var(--accent);
    border-radius: 1px;
  }
  table { border-collapse: collapse; width: 100%; max-width: 52rem; margin-top: .5rem; }
  th, td { text-align: left; padding: .6rem .9rem; border-bottom: 1px solid rgba(255,255,255,.14); font-size: 1rem; }
  th { color: var(--accent); font-size: .78rem; letter-spacing: .1em; text-transform: uppercase; }
  tbody tr:last-child td { font-weight: 700; }
  .note { margin-top: 1.5rem; color: var(--muted); font-size: .92rem; border-left: 3px solid var(--accent); padding-left: .9rem; }
  .page-number { position: absolute; right: 2rem; bottom: 1.5rem; color: var(--muted); font-size: .78rem; margin: 0; }
  @media print {
    .slide { min-height: 0; height: 100vh; border: 0; }
  }
</style>
</head>
<body>
${SLIDES.map(renderSlide).join('\n')}
</body>
</html>`;
}

function renderMarkdown(): string {
  const lines = ['# Outskill Hackathon Judge — internal briefing', ''];
  for (const [index, slide] of SLIDES.entries()) {
    lines.push(`## ${index + 1}. ${slide.title}`, '');
    if (slide.body) lines.push(slide.body, '');
    if (slide.bullets) {
      for (const bullet of slide.bullets) lines.push(`- ${bullet}`);
      lines.push('');
    }
    if (slide.table) {
      lines.push(`| ${slide.table.headers.join(' | ')} |`);
      lines.push(`| ${slide.table.headers.map(() => '---').join(' | ')} |`);
      for (const row of slide.table.rows) lines.push(`| ${row.join(' | ')} |`);
      lines.push('');
    }
    if (slide.note) lines.push(`> ${slide.note}`, '');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const outDir = `${process.cwd()}/docs/deck`;
  await mkdir(outDir, { recursive: true });

  await writeFile(`${outDir}/internal-briefing.html`, renderDeck(), 'utf8');
  await writeFile(`${outDir}/internal-briefing.md`, renderMarkdown(), 'utf8');

  process.stdout.write(
    [
      `Generated ${SLIDES.length} slides:`,
      `  docs/deck/internal-briefing.html  (open in a browser; print to PDF for slides)`,
      `  docs/deck/internal-briefing.md`,
      '',
      `Palette: black ${BRAND.black}, white ${BRAND.white}, green ${DECK_PALETTE.accent}`,
      `The green is a documented placeholder — no Outskill green exists in the supplied assets (ADR-014).`,
      '',
    ].join('\n'),
  );
}

main().catch((error) => {
  process.stderr.write(`Deck generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
