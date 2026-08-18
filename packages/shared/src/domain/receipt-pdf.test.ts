import { describe, expect, it } from 'vitest';
import {
  ReceiptSafetyError,
  assertReceiptSafe,
  generateReceiptPdf,
  receiptFilename,
  type ReceiptData,
} from './receipt-pdf';

/**
 * The receipt is a document a team keeps and forwards, so two things matter:
 * it must open in a real PDF reader, and it must never carry a credential or an
 * internal identifier out of the system.
 */

const RECEIPT: ReceiptData = {
  cohortName: 'AI Accelerator — March 2026',
  groupNumber: 12,
  productName: 'ShiftLoop',
  ideaTitle: 'Shift scheduling for small clinics',
  submittedByName: 'Priya Raman',
  submittedAtIst: '13 March 2026, 11:47 PM IST',
  receiptId: 'OHJ-7K2M-4Q8P',
};

function asText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

describe('safety assertion', () => {
  it('passes a clean receipt', () => {
    expect(() =>
      assertReceiptSafe(RECEIPT, {
        accessCode: 'S2G7E9GQR2C8',
        demoPassword: 'demo-password-123',
        submissionId: '8f7c1a2e-0000-4000-8000-000000000001',
      }),
    ).not.toThrow();
  });

  it('refuses a receipt containing the access code', () => {
    const leaked = { ...RECEIPT, productName: 'ShiftLoop (code S2G7E9GQR2C8)' };
    expect(() => assertReceiptSafe(leaked, { accessCode: 'S2G7E9GQR2C8' })).toThrow(
      ReceiptSafetyError,
    );
  });

  it('refuses a receipt containing demo credentials', () => {
    const leaked = { ...RECEIPT, submittedByName: 'demo-password-123' };
    expect(() => assertReceiptSafe(leaked, { demoPassword: 'demo-password-123' })).toThrow(
      /demo password/i,
    );
  });

  it('refuses a receipt containing an internal identifier', () => {
    const id = '8f7c1a2e-0000-4000-8000-000000000001';
    expect(() => assertReceiptSafe({ ...RECEIPT, receiptId: id }, { submissionId: id })).toThrow(
      /submission id/i,
    );
  });

  it('names the builder as the bug, because that is what has to change', () => {
    try {
      assertReceiptSafe({ ...RECEIPT, productName: 'S2G7E9GQR2C8' }, { accessCode: 'S2G7E9GQR2C8' });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toMatch(/bug in the receipt data builder/i);
    }
  });

  it('ignores short forbidden values, which would match by coincidence', () => {
    // A two-character "code" would flag every receipt containing those letters.
    expect(() => assertReceiptSafe(RECEIPT, { accessCode: 'AI' })).not.toThrow();
  });
});

describe('the generated PDF', () => {
  it('is a structurally valid PDF 1.4 file', () => {
    const text = asText(generateReceiptPdf(RECEIPT));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Page ');
    expect(text).toContain('trailer');
  });

  it('declares byte offsets that actually point at their objects', () => {
    // A wrong xref is the classic hand-rolled-PDF bug: readers either repair it
    // silently or refuse the file outright, and neither shows up without this.
    const bytes = generateReceiptPdf(RECEIPT);
    const text = asText(bytes);

    const xrefStart = text.lastIndexOf('startxref');
    const declared = Number(text.slice(xrefStart).split('\n')[1]);
    expect(text.slice(declared, declared + 4)).toBe('xref');

    const table = text.slice(text.indexOf('xref\n0 '), xrefStart);
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + 8), `object ${index + 1}`).toMatch(
        new RegExp(`^${index + 1} 0 obj`),
      );
    });
  });

  it('declares a content-stream length matching the actual bytes', () => {
    const text = asText(generateReceiptPdf(RECEIPT));
    const declared = Number(/<< \/Length (\d+) >>/.exec(text)?.[1]);
    const stream = text.slice(text.indexOf('stream\n') + 7, text.indexOf('\nendstream'));
    expect(Buffer.byteLength(stream, 'latin1')).toBe(declared);
  });

  it('carries the details a team needs to identify their entry', () => {
    const text = asText(generateReceiptPdf(RECEIPT));
    expect(text).toContain('ShiftLoop');
    expect(text).toContain('OHJ-7K2M-4Q8P');
    expect(text).toContain('Priya Raman');
    expect(text).toContain('13 March 2026, 11:47 PM IST');
    expect(text).toContain('12');
  });

  it('says nothing about judging', () => {
    const text = asText(generateReceiptPdf(RECEIPT)).toLowerCase();
    for (const forbidden of ['score', 'rank', 'shortlist', 'finalist', 'evidence', 'top 10']) {
      expect(text, `receipt mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('substitutes characters Helvetica cannot express rather than emitting noise', () => {
    const text = asText(generateReceiptPdf(RECEIPT));
    // The em dash in the cohort name becomes a hyphen.
    expect(text).toContain('AI Accelerator - March 2026');
    expect(text).not.toContain('—');
  });

  it('escapes parentheses so a product name cannot break the content stream', () => {
    const tricky = { ...RECEIPT, productName: 'Shift(Loop) \\ ) BT (' };
    const text = asText(generateReceiptPdf(tricky));
    expect(text).toContain('Shift\\(Loop\\) \\\\ \\) BT \\(');
    // Exactly one text block: the injected "BT" stayed inside a string literal.
    expect(text.match(/^BT$/gm)).toHaveLength(1);
  });

  it('drops characters outside the encoding instead of writing raw bytes', () => {
    const bytes = generateReceiptPdf({ ...RECEIPT, submittedByName: 'प्रिया 🎉' });
    const text = asText(bytes);
    expect(text).toContain('SUBMITTED BY');
    expect(text).not.toMatch(/[-￿]/);
  });

  it('produces a small file, since it goes out on a conference-hall network', () => {
    expect(generateReceiptPdf(RECEIPT).byteLength).toBeLessThan(8 * 1024);
  });
});

describe('the download filename', () => {
  it('is safe on every platform', () => {
    expect(receiptFilename('OHJ-7K2M-4Q8P')).toBe('outskill-receipt-OHJ-7K2M-4Q8P.pdf');
  });

  it('strips anything that could escape a directory or break a header', () => {
    expect(receiptFilename('../../etc/passwd')).toBe('outskill-receipt-etcpasswd.pdf');
    expect(receiptFilename('a"b\r\nX-Injected: 1')).toBe('outskill-receipt-abX-Injected1.pdf');
  });
});
