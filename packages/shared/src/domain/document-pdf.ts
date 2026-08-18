/**
 * Multi-page PDF documents.
 *
 * The receipt is one page of fixed lines; a guide is several pages of prose that
 * has to wrap and paginate. Same reasoning as `receipt-pdf.ts` — written against
 * the PDF 1.4 spec rather than pulling a multi-megabyte library into the web
 * tier, and produced in-process so no external service sees the content.
 *
 * Wrapping uses the real Helvetica advance widths rather than an average
 * character width. An estimate is either too generous (lines overflow the
 * margin) or too mean (a page of short ragged lines), and neither is something
 * you notice until someone prints it.
 */

const HELVETICA_WIDTHS = buildWidths(
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 ' +
    '556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 ' +
    '667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 ' +
    '278 278 278 469 556 333 ' +
    '556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 ' +
    '334 260 334 584',
);

const HELVETICA_BOLD_WIDTHS = buildWidths(
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 ' +
    '556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 ' +
    '722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 ' +
    '333 278 333 584 556 333 ' +
    '556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 ' +
    '389 280 389 584',
);

/** Map the space-separated AFM widths onto their code points, starting at 0x20. */
function buildWidths(spec: string): number[] {
  const values = spec.split(/\s+/).map(Number);
  const table = new Array<number>(128).fill(500);
  values.forEach((width, index) => {
    table[0x20 + index] = width;
  });
  return table;
}

export type DocFont = 'H' | 'HB';

function textWidth(text: string, size: number, font: DocFont): number {
  const widths = font === 'HB' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const character of text) {
    total += widths[character.codePointAt(0) ?? 32] ?? 500;
  }
  return (total * size) / 1000;
}

/**
 * Greedy word wrap.
 *
 * A word longer than the line is emitted on its own rather than broken: those
 * are URLs, and a URL split across lines is worse than one that overhangs.
 */
export function wrapText(text: string, size: number, font: DocFont, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, font) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// --------------------------------------------------------------------------
// Document model
// --------------------------------------------------------------------------

export type DocBlock =
  | { type: 'title'; text: string }
  | { type: 'subtitle'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string }
  | { type: 'numbered'; index: number; text: string }
  | { type: 'callout'; text: string }
  | { type: 'rule' }
  | { type: 'spacer' };

export interface DocumentSpec {
  /** PDF metadata title. */
  title: string;
  blocks: DocBlock[];
  /** Repeated at the foot of every page. */
  footer?: string;
}

const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_Y = 36;
const BOTTOM_LIMIT = FOOTER_Y + 24;

const INK: RGB = [0.06, 0.08, 0.06];
const MUTED: RGB = [0.42, 0.45, 0.41];
const ACCENT: RGB = [0.02, 0.55, 0.27];

type RGB = [number, number, number];

interface StyledLine {
  text: string;
  size: number;
  font: DocFont;
  colour: RGB;
  /** Left offset from the margin, for list indentation. */
  indent: number;
  /** Space above this line. */
  gap: number;
  /** Draw a horizontal rule at this position instead of text. */
  rule?: boolean;
  /** Keep with the following line — stops a heading stranded at a page foot. */
  keepWithNext?: boolean;
}

/** Flatten blocks into positioned, wrapped lines. */
function layout(blocks: DocBlock[]): StyledLine[] {
  const lines: StyledLine[] = [];

  const push = (
    text: string,
    size: number,
    font: DocFont,
    colour: RGB,
    gap: number,
    indent = 0,
    keepWithNext = false,
  ) => {
    for (const [index, wrapped] of wrapText(text, size, font, CONTENT_WIDTH - indent).entries()) {
      lines.push({
        text: wrapped,
        size,
        font,
        colour,
        indent,
        gap: index === 0 ? gap : 2,
        keepWithNext: keepWithNext && index === 0,
      });
    }
  };

  for (const block of blocks) {
    switch (block.type) {
      case 'title':
        push(block.text, 24, 'HB', INK, 0);
        break;
      case 'subtitle':
        push(block.text, 11, 'H', MUTED, 8);
        break;
      case 'heading':
        push(block.text, 14, 'HB', INK, 26, 0, true);
        break;
      case 'paragraph':
        push(block.text, 10.5, 'H', INK, 12);
        break;
      case 'bullet':
        push(`\u2022  ${block.text}`, 10.5, 'H', INK, 7, 14);
        break;
      case 'numbered':
        push(`${block.index}.  ${block.text}`, 10.5, 'H', INK, 7, 14);
        break;
      case 'callout':
        push(block.text, 10.5, 'HB', ACCENT, 14, 0);
        break;
      case 'rule':
        lines.push({ text: '', size: 0, font: 'H', colour: ACCENT, indent: 0, gap: 18, rule: true });
        break;
      case 'spacer':
        lines.push({ text: '', size: 6, font: 'H', colour: INK, indent: 0, gap: 0 });
        break;
      default: {
        const exhaustive: never = block;
        throw new Error(`Unhandled block: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return lines;
}

/** Escape the three characters that terminate a PDF string literal. */
function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Flatten to WinAnsi-representable characters.
 *
 * The built-in Helvetica encoding cannot express an em dash or a curly quote,
 * and prose written for the web is full of both.
 */
export function toWinAnsi(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    // Non-breaking space, escaped: invisible in source otherwise.
    .replace(/\u00A0/g, ' ')
    .replace(/\u2022/g, '-')
    .replace(/[^\x20-\x7E]/g, '');
}

/** Build a paginated PDF. Returns raw bytes suitable for a download response. */
export function generateDocumentPdf(spec: DocumentSpec): Uint8Array {
  const lines = layout(spec.blocks);
  const pages: string[] = [];

  let parts: string[] = [];
  let cursor = PAGE_HEIGHT - MARGIN;

  const endPage = () => {
    if (parts.length === 0) return;
    if (spec.footer) {
      parts.push(
        'BT',
        `${MUTED[0].toFixed(3)} ${MUTED[1].toFixed(3)} ${MUTED[2].toFixed(3)} rg`,
        '/H 8 Tf',
        `1 0 0 1 ${MARGIN} ${FOOTER_Y} Tm`,
        `(${pdfEscape(toWinAnsi(`${spec.footer}  —  page ${pages.length + 1}`))}) Tj`,
        'ET',
      );
    }
    pages.push(parts.join('\n'));
    parts = [];
    cursor = PAGE_HEIGHT - MARGIN;
  };

  for (const [index, line] of lines.entries()) {
    const advance = line.gap + (line.rule ? 2 : line.size);
    // A heading alone at the foot of a page reads as a mistake, so it moves
    // with the line it introduces.
    const needed = line.keepWithNext ? advance + (lines[index + 1]?.size ?? 0) + 8 : advance;

    if (cursor - needed < BOTTOM_LIMIT) endPage();
    cursor -= advance;

    if (line.rule) {
      parts.push(
        `${ACCENT[0].toFixed(3)} ${ACCENT[1].toFixed(3)} ${ACCENT[2].toFixed(3)} RG`,
        '1 w',
        `${MARGIN} ${cursor.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${cursor.toFixed(2)} l S`,
      );
      continue;
    }
    if (!line.text) continue;

    const [r, g, b] = line.colour;
    parts.push(
      'BT',
      `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`,
      `/${line.font} ${line.size} Tf`,
      `1 0 0 1 ${(MARGIN + line.indent).toFixed(2)} ${cursor.toFixed(2)} Tm`,
      `(${pdfEscape(toWinAnsi(line.text))}) Tj`,
      'ET',
    );
  }
  endPage();
  if (pages.length === 0) pages.push('');

  return assemble(pages, spec.title);
}

/**
 * Write the object graph and cross-reference table.
 *
 * Object numbering: 1 catalog, 2 pages, 3 font, 4 bold font, then a page and a
 * content stream per page.
 */
function assemble(pages: string[], title: string): Uint8Array {
  const objects: string[] = [];
  const firstPageObject = 5;
  const kids = pages.map((_, index) => `${firstPageObject + index * 2} 0 R`).join(' ');

  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );

  pages.forEach((content, index) => {
    const contentObject = firstPageObject + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /H 3 0 R /HB 4 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  });

  const infoObject = objects.length + 1;
  objects.push(`<< /Title (${pdfEscape(toWinAnsi(title))}) /Producer (Outskill Hackathon Judge) >>`);

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
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
