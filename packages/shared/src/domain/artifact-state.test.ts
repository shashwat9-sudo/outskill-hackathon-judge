import { describe, expect, it } from 'vitest';
import {
  missingArtifactRequirements,
  resolveArtifactsStep,
  type AttachedArtifact,
} from './artifact-state';

/**
 * The disagreement that produced the defect.
 *
 * Found during the Phase A acceptance run. Group 901's Demo-and-deck step showed
 * a PDF uploaded, a demo video URL saved, and the duration confirmed. Review
 * reported all three missing.
 *
 * Both records existed: two artifact rows in the database, and a draft payload
 * holding `{deckArtifactId: "", demoVideoUrl: "", demoUnderThreeMinutes: true}`.
 * The payload was merged last, so its empty strings shadowed the real
 * artifacts — and re-uploading could not fix it, because that writes an artifact
 * row and never touches the payload.
 */

const deck: AttachedArtifact = { id: 'artifact-deck-1', kind: 'deck_pdf' };
const video: AttachedArtifact = {
  id: 'artifact-video-1',
  kind: 'demo_video',
  externalUrl: 'https://www.loom.com/share/abc123',
};

describe('an attached artifact beats an empty draft field', () => {
  it('reports the deck that is actually attached', () => {
    // The exact payload recovered from group 901.
    const stored = { deckArtifactId: '', demoVideoUrl: '', demoUnderThreeMinutes: true };
    const step = resolveArtifactsStep(stored, [deck, video]);

    expect(step.deckArtifactId).toBe('artifact-deck-1');
  });

  it('reports the demo video that is actually saved', () => {
    const stored = { deckArtifactId: '', demoVideoUrl: '', demoUnderThreeMinutes: true };
    const step = resolveArtifactsStep(stored, [deck, video]);

    expect(step.demoVideoUrl).toBe('https://www.loom.com/share/abc123');
  });

  it('leaves nothing for Review to complain about', () => {
    // The whole reported symptom, stated as one assertion.
    const stored = { deckArtifactId: '', demoVideoUrl: '', demoUnderThreeMinutes: true };
    const step = resolveArtifactsStep(stored, [deck, video]);

    expect(missingArtifactRequirements(step)).toEqual([]);
  });

  it('ignores a stale id left over from a previous upload', () => {
    // Replacing a deck writes a new row. The payload would still name the old.
    const stored = { deckArtifactId: 'artifact-deck-OLD', demoUnderThreeMinutes: true };
    const step = resolveArtifactsStep(stored, [deck, video]);

    expect(step.deckArtifactId).toBe('artifact-deck-1');
  });
});

describe('the declaration keeps its home in the draft', () => {
  it('is preserved, because nothing else stores it', () => {
    // No artifact row exists for "the video is under three minutes".
    const step = resolveArtifactsStep({ demoUnderThreeMinutes: true }, [deck, video]);
    expect(step.demoUnderThreeMinutes).toBe(true);
  });

  it('defaults to false rather than assuming a learner confirmed something', () => {
    expect(resolveArtifactsStep(undefined, [deck, video]).demoUnderThreeMinutes).toBe(false);
    expect(resolveArtifactsStep({}, []).demoUnderThreeMinutes).toBe(false);
  });

  it('still blocks Review when it is missing, even with both files attached', () => {
    const step = resolveArtifactsStep({ demoUnderThreeMinutes: false }, [deck, video]);
    expect(missingArtifactRequirements(step)).toEqual([
      'Confirm that your demo video is three minutes or shorter.',
    ]);
  });
});

describe('nothing attached', () => {
  it('reports empty, so a learner is not told they have a deck they do not', () => {
    // The opposite failure: a draft field must not invent an artifact either.
    const stored = { deckArtifactId: 'invented', demoVideoUrl: 'https://example.com/video' };
    const step = resolveArtifactsStep(stored, []);

    expect(step.deckArtifactId).toBe('');
    expect(step.demoVideoUrl).toBe('');
  });

  it('lists every requirement', () => {
    expect(missingArtifactRequirements(resolveArtifactsStep({}, []))).toEqual([
      'Upload your pitch deck as a PDF.',
      'A demo video link is required.',
      'Confirm that your demo video is three minutes or shorter.',
    ]);
  });
});

describe('a partially completed step', () => {
  it('names only what is genuinely outstanding', () => {
    const step = resolveArtifactsStep({ demoUnderThreeMinutes: true }, [deck]);
    expect(missingArtifactRequirements(step)).toEqual(['A demo video link is required.']);
  });

  it('treats a demo video row with no URL as no video', () => {
    // An artifact row exists but carries nothing to watch.
    const empty: AttachedArtifact = { id: 'v', kind: 'demo_video', externalUrl: null };
    const step = resolveArtifactsStep({ demoUnderThreeMinutes: true }, [deck, empty]);

    expect(step.demoVideoUrl).toBe('');
    expect(missingArtifactRequirements(step)).toContain('A demo video link is required.');
  });
});

describe('survives a reload', () => {
  it('produces the same answer from the same inputs', () => {
    // Reload rebuilds this from the stored payload and the artifact rows. Two
    // runs must agree, or a learner sees the step change under them.
    const stored = { deckArtifactId: '', demoVideoUrl: '', demoUnderThreeMinutes: true };
    const first = resolveArtifactsStep(stored, [deck, video]);
    const second = resolveArtifactsStep(stored, [deck, video]);

    expect(second).toEqual(first);
    expect(missingArtifactRequirements(second)).toEqual([]);
  });
});
