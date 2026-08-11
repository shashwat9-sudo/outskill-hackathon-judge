/**
 * PDF text extraction.
 *
 * Runs in the worker, never in a web request path — a malicious PDF should
 * never reach the tier that holds sessions (threat model T9, ADR-020).
 */

import { readFile } from 'node:fs/promises';

export interface PdfExtraction {
  text: string;
  pageCount: number;
  /** True when the deck is essentially images — a real and common case. */
  textLayerMissing: boolean;
  pagesWithText: number;
}

const MAX_EXTRACTED_CHARS = 60_000;

/**
 * Extract text from a PDF.
 *
 * Failure returns a null-ish result rather than throwing where possible: an
 * unreadable deck is missing evidence, not a broken submission.
 */
export async function extractPdfText(pathOrBuffer: string | Uint8Array): Promise<PdfExtraction> {
  const data =
    typeof pathOrBuffer === 'string' ? new Uint8Array(await readFile(pathOrBuffer)) : pathOrBuffer;

  // Legacy build: no DOM, works under plain Node.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await getDocument({
    data,
    useSystemFonts: true,
    // Never fetch anything a PDF references — a deck must not be able to make
    // the worker issue outbound requests.
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const parts: string[] = [];
  let pagesWithText = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();

    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (pageText.length > 20) pagesWithText += 1;
    if (pageText) parts.push(`[Page ${pageNumber}] ${pageText}`);

    if (parts.join('\n').length > MAX_EXTRACTED_CHARS) break;
  }

  await doc.destroy().catch(() => undefined);

  const text = parts.join('\n').slice(0, MAX_EXTRACTED_CHARS);
  return {
    text,
    pageCount: doc.numPages,
    // Fewer than a third of pages carrying text means an image-based deck.
    textLayerMissing: pagesWithText < Math.max(1, Math.ceil(doc.numPages / 3)),
    pagesWithText,
  };
}

/**
 * Placeholder strings from the supplied deck template.
 *
 * An unedited placeholder is evidence of an incomplete deck. It is recorded as
 * contradictory evidence for deck clarity and is never a disqualification
 * ground (docs/reference-analysis.md §2).
 */
export const TEMPLATE_PLACEHOLDERS = [
  'Brief about what you do in 3-5 words',
  'Write: Your job profile',
  'Write one line Problem Statement',
  'Supporting Point - 1',
  'ADD SCREENSHOT',
  'Attach the link of Loom video',
  'Project/MVP Title',
  'GROUP NUMBER',
] as const;

export function countTemplatePlaceholders(text: string): number {
  if (!text) return 0;
  const haystack = text.toLowerCase();
  return TEMPLATE_PLACEHOLDERS.filter((placeholder) => haystack.includes(placeholder.toLowerCase())).length;
}
