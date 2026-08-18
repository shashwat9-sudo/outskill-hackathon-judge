/**
 * Which record of an artifact is the truth.
 *
 * A deck and a demo video are saved by their own actions — an upload, and a URL
 * save — neither of which passes through the submission form's state. The form
 * also saves a draft payload containing a `deckArtifactId` and a `demoVideoUrl`
 * field, and those are empty whenever the step was saved before the file was
 * attached.
 *
 * So there are two records of the same fact, and they disagree. Merging the
 * draft payload last meant its empty strings shadowed real artifacts
 * permanently: the page showed the deck and the video, and Review reported both
 * missing, with no way for the learner to correct it — re-uploading wrote a new
 * artifact row and changed nothing about the payload.
 *
 * An artifact row is created only when something is genuinely attached, so it
 * is the authority. The draft payload keeps only what has nowhere else to live.
 */

export interface StoredArtifactsStep {
  deckArtifactId?: string;
  demoVideoUrl?: string;
  demoUnderThreeMinutes?: boolean;
  transcriptArtifactId?: string;
  screenshotArtifactIds?: string[];
}

export interface AttachedArtifact {
  id: string;
  kind: string;
  externalUrl?: string | null;
}

export interface ResolvedArtifactsStep {
  deckArtifactId: string;
  demoVideoUrl: string;
  demoUnderThreeMinutes: boolean;
  transcriptArtifactId?: string;
  screenshotArtifactIds: string[];
}

/**
 * Resolve step 4 from both records.
 *
 * `demoUnderThreeMinutes` is a declaration rather than an artifact: nobody
 * uploads it, so the draft payload is its only home and it is taken from there.
 */
export function resolveArtifactsStep(
  stored: StoredArtifactsStep | undefined,
  attached: readonly AttachedArtifact[],
): ResolvedArtifactsStep {
  const deck = attached.find((a) => a.kind === 'deck_pdf');
  const video = attached.find((a) => a.kind === 'demo_video');

  return {
    ...(stored ?? {}),
    // Attached files win. An empty string here means nothing is attached, which
    // is a fact about the submission rather than a gap in the draft.
    deckArtifactId: deck?.id ?? '',
    demoVideoUrl: video?.externalUrl ?? '',
    demoUnderThreeMinutes: stored?.demoUnderThreeMinutes ?? false,
    screenshotArtifactIds: stored?.screenshotArtifactIds ?? [],
  };
}

/**
 * What step 4 is still missing, in the learner's words.
 *
 * Computed from the same resolved state the form renders, so a learner can
 * never be told on the review screen that something is missing while the step
 * itself shows it as saved.
 */
export function missingArtifactRequirements(step: ResolvedArtifactsStep): string[] {
  const missing: string[] = [];
  if (!step.deckArtifactId) missing.push('Upload your pitch deck as a PDF.');
  if (!step.demoVideoUrl) missing.push('A demo video link is required.');
  if (!step.demoUnderThreeMinutes) {
    missing.push('Confirm that your demo video is three minutes or shorter.');
  }
  return missing;
}
