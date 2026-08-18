import {
  buildSubmissionGuide,
  formatInTimezone,
  generateDocumentPdf,
  guideToBlocks,
  timezoneLabel,
} from '@ohj/shared';
import { getEnvConfig, getStoreAsync } from '@/lib/store';

/**
 * How long this may run on a serverless host.
 *
 * Renders the guide PDF in-process.
 */
export const maxDuration = 30;

export const dynamic = 'force-dynamic';

/**
 * The two-day guide, as a PDF.
 *
 * Built from the same content as the page, so a team working from the printout
 * and a team working from the screen are following identical instructions.
 * Generated in-process — no external service, no paid API.
 *
 * Open to anyone, like the page: these are instructions, not results.
 */
export async function GET() {
  const cohort = await (await getStoreAsync()).cohorts.findActiveCohort();
  const env = getEnvConfig();

  const guide = buildSubmissionGuide({
    cohortName: cohort?.name ?? 'AI Accelerator',
    deadlineLabel: cohort
      ? `${formatInTimezone(cohort.acceptingUntil ?? cohort.day13DeadlineAt, cohort.timezone, {
          dateStyle: 'full',
          timeStyle: 'short',
        })} ${timezoneLabel(cohort.day13DeadlineAt, cohort.timezone)}`
      : 'at the end of Day 13',
    submitUrl: `${env.APP_BASE_URL}/submit`,
  });

  const pdf = generateDocumentPdf({
    title: guide.title,
    blocks: guideToBlocks(guide),
    footer: `Outskill AI Accelerator — ${guide.subtitle}`,
  });

  return new Response(pdf.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(pdf.byteLength),
      'content-disposition': 'inline; filename="outskill-two-day-submission-guide.pdf"',
      // Cacheable: it is the same document for everyone, and it changes only
      // when the cohort's deadline does.
      'cache-control': 'public, max-age=300',
    },
  });
}
