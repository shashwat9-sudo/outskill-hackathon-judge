import { cookies } from 'next/headers';
import {
  PARTICIPANT_SESSION_COOKIE,
  assertReceiptSafe,
  formatInTimezone,
  generateReceiptPdf,
  receiptFilename,
} from '@ohj/shared';
import { getStoreAsync } from '@/lib/store';

/**
 * How long this may run on a serverless host.
 *
 * Renders a PDF in-process. Fast, but a cold start plus a database read
 * should not be racing a 10-second default.
 */
export const maxDuration = 30;

export const dynamic = 'force-dynamic';

/**
 * Receipt download.
 *
 * Served from `/submit/receipt`, NOT `/api/receipt`, and that matters.
 *
 * The participant session cookie is scoped to `path=/submit` — deliberately, so
 * it is never sent to routes that have no business seeing it. A receipt route
 * outside that path therefore never receives it: the browser simply omits the
 * cookie, the route finds no session, and every learner is told "No receipt is
 * available for this session" while looking at their receipt on screen.
 *
 * That is exactly what happened. It was found by clicking the button on a real
 * submitted submission, and it had never worked for anybody.
 *
 * The session cookie is the only input. Nothing identifying a submission is
 * accepted from the request, so this cannot be pointed at another team's
 * receipt by editing a URL.
 *
 * The bytes are generated in-process — no external or paid service sees a
 * participant's details.
 */
export async function GET() {
  const token = (await cookies()).get(PARTICIPANT_SESSION_COOKIE)?.value;
  if (!token) return unauthorised();

  const store = await getStoreAsync();
  const receipt = await store.participant.getReceipt(token);
  // Null for an invalid session and for a submission that is still a draft.
  // Both mean the same thing to the caller: there is no receipt to download.
  if (!receipt) return unauthorised();

  const data = {
    cohortName: receipt.cohortName,
    groupNumber: receipt.groupNumber,
    productName: receipt.productName,
    ideaTitle: receipt.ideaTitle,
    submittedByName: receipt.submittedByName,
    submittedAtIst: `${formatInTimezone(receipt.submittedAt, receipt.cohortTimezone, {
      dateStyle: 'full',
      timeStyle: 'short',
    })} IST`,
    receiptId: receipt.receiptId,
  };

  // Belt and braces: refuse to emit a receipt that somehow carries the session
  // token or an internal identifier. A throw here is a bug in the data builder,
  // not something a participant can trigger.
  assertReceiptSafe(data, { accessCode: token });

  const pdf = generateReceiptPdf(data);

  // `pdf.buffer` rather than `pdf`: the DOM lib's BodyInit predates typed-array
  // support, and a cast would hide a real mismatch if that ever changed.
  return new Response(pdf.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(pdf.byteLength),
      'content-disposition': `attachment; filename="${receiptFilename(receipt.receiptId)}"`,
      // A receipt is per-team and per-session: never let a shared cache hold it.
      'cache-control': 'private, no-store',
    },
  });
}

function unauthorised(): Response {
  return new Response('No receipt is available for this session.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
