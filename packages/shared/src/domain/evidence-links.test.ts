import { describe, expect, it } from 'vitest';
import { resolveEvidenceLink } from './evidence-links';

/**
 * Reading a supporting-evidence link.
 *
 * This exists because a Google Drive share URL is not a document. Requesting
 * the URL a team pastes out of Drive returns a viewer page — HTML, 200 OK, and
 * no PDF anywhere in it. Judged naively that reads as "the deck is unreadable",
 * which is a finding about a team who did nothing wrong.
 */

describe('Google Drive deck links', () => {
  it('turns the share URL a team actually pastes into a download URL', () => {
    // The exact form the C13 sheet contains.
    const link = resolveEvidenceLink(
      'https://drive.google.com/open?id=1gsFyGihooBwZ3jxfsHS5V-OnJ_CzjWXk',
    );

    expect(link?.kind).toBe('google_drive_file');
    expect(link?.fileId).toBe('1gsFyGihooBwZ3jxfsHS5V-OnJ_CzjWXk');
    expect(link?.fetchUrl).toContain('export=download');
    expect(link?.fetchUrl).toContain('1gsFyGihooBwZ3jxfsHS5V-OnJ_CzjWXk');
    // The original survives for display and audit — we never rewrite what the
    // team submitted, only where we go to read it.
    expect(link?.originalUrl).toBe(
      'https://drive.google.com/open?id=1gsFyGihooBwZ3jxfsHS5V-OnJ_CzjWXk',
    );
  });

  it('reads the id out of the /file/d/<id>/view form as well', () => {
    const link = resolveEvidenceLink('https://drive.google.com/file/d/ABC123xyz/view?usp=sharing');

    expect(link?.kind).toBe('google_drive_file');
    expect(link?.fileId).toBe('ABC123xyz');
  });

  it('exports a Slides deck as PDF rather than fetching the editor page', () => {
    const link = resolveEvidenceLink('https://docs.google.com/presentation/d/DECK99/edit#slide=id.p');

    expect(link?.kind).toBe('google_workspace_doc');
    expect(link?.fetchUrl).toBe('https://docs.google.com/presentation/d/DECK99/export?format=pdf');
  });

  it('skips the virus-scan interstitial, which is served instead of large decks', () => {
    const link = resolveEvidenceLink('https://drive.google.com/open?id=BIGDECK');
    expect(link?.fetchUrl).toContain('confirm=t');
  });
});

describe('other links', () => {
  it('recognises a Loom link as a video and never as something to download', () => {
    const link = resolveEvidenceLink('https://www.loom.com/share/70fc0c9de0004cbc8347a5bf2e41b0fe');
    expect(link?.kind).toBe('video');
    expect(link?.fetchUrl).toBe('https://www.loom.com/share/70fc0c9de0004cbc8347a5bf2e41b0fe');
  });

  it('passes an ordinary hosted PDF through unchanged', () => {
    const link = resolveEvidenceLink('https://example.com/decks/sizzle.pdf');
    expect(link?.kind).toBe('direct');
    expect(link?.fetchUrl).toBe('https://example.com/decks/sizzle.pdf');
  });

  it('treats a blank or non-URL cell as no link at all', () => {
    /*
     * Distinct from a link that fails: a team who typed "coming soon" supplied
     * nothing, and a team whose Drive file is private supplied something that
     * did not work. Downstream says different things about each.
     */
    expect(resolveEvidenceLink(null)).toBeNull();
    expect(resolveEvidenceLink('   ')).toBeNull();
    expect(resolveEvidenceLink('coming soon')).toBeNull();
    expect(resolveEvidenceLink('javascript:alert(1)')).toBeNull();
    expect(resolveEvidenceLink('file:///etc/passwd')).toBeNull();
  });
});
