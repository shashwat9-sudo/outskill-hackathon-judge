/**
 * Receipt PDF generation.
 *
 * Written by hand against the PDF 1.4 spec rather than pulled in as a
 * dependency. A receipt is a single page of text in one built-in font, and a
 * PDF library would be several megabytes of transitive dependency in the web
 * tier for that. No external or paid service is involved — the bytes are
 * produced in-process.
 *
 * What the receipt may contain is constrained deliberately: it is a document a
 * team keeps and forwards, so it carries no access code, no credentials, no
 * internal identifiers beyond the public receipt ID, and nothing about judging.
 */

export interface ReceiptData {
  cohortName: string;
  groupNumber: number;
  productName: string;
  ideaTitle: string;
  submittedByName: string;
  /** Pre-formatted in the cohort timezone (IST for the accelerator). */
  submittedAtIst: string;
  receiptId: string;
}

/** Values that must never reach a receipt, asserted before bytes are produced. */
export interface ReceiptSafetyInput {
  accessCode?: string | null;
  demoUsername?: string | null;
  demoPassword?: string | null;
  submissionId?: string | null;
  teamId?: string | null;
}

export class ReceiptSafetyError extends Error {
  override readonly name = 'ReceiptSafetyError';
}

/**
 * Refuse to build a receipt containing anything sensitive.
 *
 * Throws rather than scrubbing: a credential reaching this function means a
 * caller assembled the wrong data, and quietly removing it would hide the bug.
 */
export function assertReceiptSafe(data: ReceiptData, forbidden: ReceiptSafetyInput): void {
  const serialised = JSON.stringify(data);
  const checks: [string, string | null | undefined][] = [
    ['access code', forbidden.accessCode],
    ['demo username', forbidden.demoUsername],
    ['demo password', forbidden.demoPassword],
    ['internal submission id', forbidden.submissionId],
    ['internal team id', forbidden.teamId],
  ];

  for (const [label, value] of checks) {
    if (value && value.length >= 6 && serialised.includes(value)) {
      throw new ReceiptSafetyError(
        `Refusing to generate a receipt containing the ${label}. This is a bug in the receipt data builder.`,
      );
    }
  }
}

// --------------------------------------------------------------------------
// Minimal PDF writer
// --------------------------------------------------------------------------

/** Escape the three characters that terminate a PDF string literal. */
function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Flatten to WinAnsi-representable characters.
 *
 * The built-in Helvetica encoding cannot express an em dash or a curly quote,
 * and a cohort name will contain both. Substituting is better than emitting
 * bytes a reader renders as noise.
 */
function toWinAnsi(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    // Non-breaking space, written escaped: invisible in source otherwise.
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E]/g, '');
}

interface TextLine {
  text: string;
  size: number;
  font: 'H' | 'HB';
  /** Extra space above this line, in points. */
  gap: number;
  colour?: [number, number, number];
}

const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;

/**
 * Build the receipt PDF.
 *
 * Returns raw bytes suitable for a download response.
 */
export function generateReceiptPdf(data: ReceiptData): Uint8Array {
  const accent: [number, number, number] = [0.02, 0.55, 0.27];
  const muted: [number, number, number] = [0.42, 0.45, 0.41];
  const ink: [number, number, number] = [0.06, 0.08, 0.06];

  const lines: TextLine[] = [
    { text: 'OUTSKILL', size: 20, font: 'HB', gap: 0, colour: ink },
    { text: 'AI ACCELERATOR HACKATHON', size: 9, font: 'HB', gap: 6, colour: accent },
    { text: 'Submission received', size: 26, font: 'HB', gap: 40, colour: ink },
    { text: '', size: 10, font: 'H', gap: 8 },

    { text: 'COHORT', size: 8, font: 'HB', gap: 18, colour: muted },
    { text: data.cohortName, size: 12, font: 'H', gap: 4, colour: ink },

    { text: 'GROUP NUMBER', size: 8, font: 'HB', gap: 16, colour: muted },
    { text: String(data.groupNumber), size: 12, font: 'H', gap: 4, colour: ink },

    { text: 'PRODUCT', size: 8, font: 'HB', gap: 16, colour: muted },
    { text: data.productName, size: 12, font: 'H', gap: 4, colour: ink },

    { text: 'SELECTED PRODUCT IDEA', size: 8, font: 'HB', gap: 16, colour: muted },
    { text: data.ideaTitle, size: 12, font: 'H', gap: 4, colour: ink },

    { text: 'SUBMITTED BY', size: 8, font: 'HB', gap: 16, colour: muted },
    { text: data.submittedByName, size: 12, font: 'H', gap: 4, colour: ink },

    { text: 'SUBMITTED AT', size: 8, font: 'HB', gap: 16, colour: muted },
    { text: data.submittedAtIst, size: 12, font: 'H', gap: 4, colour: ink },

    { text: 'RECEIPT ID', size: 8, font: 'HB', gap: 16, colour: muted },
    { text: data.receiptId, size: 15, font: 'HB', gap: 4, colour: accent },

    {
      text: 'Your submission is locked. The Outskill programme team can reopen it',
      size: 10,
      font: 'H',
      gap: 40,
      colour: muted,
    },
    { text: 'only when an exception is approved.', size: 10, font: 'H', gap: 4, colour: muted },
    {
      text: 'Keep this receipt. It identifies your submission if you contact Outskill.',
      size: 10,
      font: 'H',
      gap: 16,
      colour: muted,
    },
  ];

  // --- content stream ---
  const parts: string[] = ['BT'];
  let cursor = PAGE_HEIGHT - MARGIN;

  for (const line of lines) {
    cursor -= line.gap + line.size;
    const [r, g, b] = line.colour ?? ink;
    parts.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    parts.push(`/${line.font} ${line.size} Tf`);
    // Absolute positioning per line keeps the maths obvious and avoids leading
    // state carrying between lines of different sizes.
    parts.push(`1 0 0 1 ${MARGIN} ${cursor.toFixed(2)} Tm`);
    parts.push(`(${pdfEscape(toWinAnsi(line.text))}) Tj`);
  }
  parts.push('ET');

  // A rule under the header.
  const ruleY = PAGE_HEIGHT - MARGIN - 96;
  parts.push(
    `${accent[0].toFixed(3)} ${accent[1].toFixed(3)} ${accent[2].toFixed(3)} RG`,
    '1.5 w',
    `${MARGIN} ${ruleY.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${ruleY.toFixed(2)} l S`,
  );

  const content = parts.join('\n');

  // --- objects ---
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /H 5 0 R /HB 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/** Download filename, safe on every platform. */
export function receiptFilename(receiptId: string): string {
  return `outskill-receipt-${receiptId.replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
}
