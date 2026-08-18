import { describe, expect, it } from 'vitest';
import { generateDocumentPdf, toWinAnsi, wrapText, type DocBlock } from './document-pdf';
import { buildSubmissionGuide, guideToBlocks } from '../content/submission-guide';

/**
 * The multi-page PDF writer.
 *
 * Two things break hand-rolled PDFs: a cross-reference table whose offsets do
 * not point at their objects, and text that silently runs off the page. Both
 * open fine in some readers and fail in others, so both are asserted here.
 */

const GUIDE = buildSubmissionGuide({
  cohortName: 'AI Accelerator — March 2026',
  deadlineLabel: 'Friday 13 March 2026, 11:59 PM IST',
  submitUrl: 'https://judge.outskill.test/submit',
});

function asText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

describe('word wrapping', () => {
  it('keeps every line inside the given width', () => {
    const width = 200;
    const lines = wrapText(
      'Deploy somewhere public. Vercel, Netlify, Render, Railway or Replit all work.',
      10.5,
      'H',
      width,
    );
    expect(lines.length).toBeGreaterThan(1);
    // Recombining must lose nothing.
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe(
      'Deploy somewhere public. Vercel, Netlify, Render, Railway or Replit all work.',
    );
  });

  it('measures bold as wider than regular, because it is', () => {
    const text = 'Submissions close at the end of Day 13';
    const regular = wrapText(text, 10.5, 'H', 150).length;
    const bold = wrapText(text, 10.5, 'HB', 150).length;
    expect(bold).toBeGreaterThanOrEqual(regular);
  });

  it('emits an over-long word on its own rather than breaking it', () => {
    // These are URLs. A URL split across two lines is worse than one that
    // overhangs, because it stops being clickable and starts being wrong.
    const lines = wrapText('See https://a-very-long-hostname.example.com/path/to/thing', 10.5, 'H', 60);
    expect(lines).toContain('https://a-very-long-hostname.example.com/path/to/thing');
  });

  it('handles empty and whitespace-only input', () => {
    expect(wrapText('', 10, 'H', 100)).toEqual(['']);
    expect(wrapText('   ', 10, 'H', 100)).toEqual(['']);
  });
});

describe('WinAnsi flattening', () => {
  it('substitutes typography Helvetica cannot express', () => {
    expect(toWinAnsi('“quoted” — it’s a test… •')).toBe('"quoted" - it\'s a test... -');
  });

  it('drops anything still outside the encoding, keeping the ASCII around it', () => {
    expect(toWinAnsi('प्रिया')).toBe('');
    expect(toWinAnsi('Team 🎉 Twelve')).toBe('Team  Twelve');
  });
});

describe('the generated document', () => {
  const blocks: DocBlock[] = guideToBlocks(GUIDE);

  it('is a structurally valid PDF', () => {
    const text = asText(generateDocumentPdf({ title: GUIDE.title, blocks }));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
  });

  it('paginates a long document', () => {
    const text = asText(generateDocumentPdf({ title: GUIDE.title, blocks }));
    const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)?.[1]);
    expect(count).toBeGreaterThan(1);
    expect(text.match(/\/Type \/Page /g)).toHaveLength(count);
  });

  it('declares byte offsets that actually point at their objects', () => {
    const text = asText(generateDocumentPdf({ title: GUIDE.title, blocks }));

    const xrefStart = text.lastIndexOf('startxref');
    const declared = Number(text.slice(xrefStart).split('\n')[1]);
    expect(text.slice(declared, declared + 4)).toBe('xref');

    const table = text.slice(text.indexOf('xref\n0 '), xrefStart);
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(6);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + 12), `object ${index + 1}`).toMatch(
        new RegExp(`^${index + 1} 0 obj`),
      );
    });
  });

  it('declares content-stream lengths matching the actual bytes', () => {
    const text = asText(generateDocumentPdf({ title: GUIDE.title, blocks }));
    const streams = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
    expect(streams.length).toBeGreaterThan(1);
    for (const [, declared, body] of streams) {
      expect(Buffer.byteLength(body as string, 'latin1')).toBe(Number(declared));
    }
  });

  it('keeps every text position inside the printable area', () => {
    // The failure this catches is invisible in the byte stream and obvious on
    // paper: a line positioned past the margin, or below the footer.
    const text = asText(generateDocumentPdf({ title: GUIDE.title, blocks }));
    const positions = [...text.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)];
    expect(positions.length).toBeGreaterThan(20);

    for (const [, x, y] of positions) {
      expect(Number(x)).toBeGreaterThanOrEqual(56);
      expect(Number(x)).toBeLessThan(595.28 - 56);
      expect(Number(y)).toBeGreaterThanOrEqual(30);
      expect(Number(y)).toBeLessThanOrEqual(841.89 - 56);
    }
  });

  it('puts the footer on every page', () => {
    const text = asText(
      generateDocumentPdf({ title: GUIDE.title, blocks, footer: 'Outskill AI Accelerator' }),
    );
    const pages = Number(/\/Count (\d+)/.exec(text)?.[1]);
    expect(text.match(/Outskill AI Accelerator/g)?.length).toBeGreaterThanOrEqual(pages);
    expect(text).toContain('page 1');
    expect(text).toContain(`page ${pages}`);
  });

  it('escapes parentheses so content cannot break the stream', () => {
    const text = asText(
      generateDocumentPdf({
        title: 'Test',
        blocks: [{ type: 'paragraph', text: 'A (tricky) line with a \\ backslash and ) a paren' }],
      }),
    );
    expect(text).toContain('A \\(tricky\\) line with a \\\\ backslash and \\) a paren');
  });

  it('survives an empty document', () => {
    const text = asText(generateDocumentPdf({ title: 'Empty', blocks: [] }));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 1');
  });
});

describe('the two-day guide', () => {
  it('covers every stage a team has to get through', () => {
    const ids = GUIDE.sections.map((section) => section.id);
    expect(ids).toEqual([
      'shape',
      // What the six steps are and what to have ready, read from the same
      // guidance the form shows — so the guide cannot describe a form that no
      // longer exists.
      'steps',
      'live',
      'deck',
      'demo',
      'evidence',
      'submitting',
      'mistakes',
      'help',
    ]);
  });

  it('carries the deadline and the submission URL into the text', () => {
    const text = JSON.stringify(GUIDE);
    expect(text).toContain('Friday 13 March 2026, 11:59 PM IST');
    expect(text).toContain('https://judge.outskill.test/submit');
  });

  it('says nothing about scoring beyond what participants may see', () => {
    // Telling teams how to optimise against a rubric changes what they build,
    // and assessment detail is internal (ADR-011).
    const text = JSON.stringify(GUIDE).toLowerCase();
    for (const forbidden of ['points', 'rubric', 'shortlist', 'rank', 'finalist', 'top 10', 'weight']) {
      expect(text, `guide mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('warns about the things that actually go wrong', () => {
    const text = JSON.stringify(GUIDE).toLowerCase();
    expect(text).toContain('localhost');
    expect(text).toContain('anyone with the link can view');
    expect(text).toContain('never use real customer data');
  });

  it('numbers steps within a section, not across the document', () => {
    const blocks = guideToBlocks(GUIDE);
    const numbered = blocks.filter((b): b is Extract<DocBlock, { type: 'numbered' }> =>
      b.type === 'numbered',
    );
    // Every section that has steps starts again at 1.
    expect(numbered.filter((b) => b.index === 1).length).toBeGreaterThan(1);
  });
});
