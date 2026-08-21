/**
 * Supporting-evidence links.
 *
 * A team gives us a Loom link and a deck link. Neither is a file we hold — the
 * Judge never takes an upload from a learner — so before anything can look at a
 * deck it has to work out what the link actually points at.
 *
 * Almost every deck arrives as a Google Drive share URL, and a Drive share URL
 * is a viewer page, not a document: fetching it returns HTML with a login
 * gate, which is indistinguishable from a broken link unless you know to ask
 * for the file instead. That translation is the whole job of this module.
 *
 * It resolves links only. It never fetches, so it can say what a link means
 * without any of the egress rules that govern actually going there.
 */

/** What a supporting-evidence link turned out to be. */
export type EvidenceLinkKind =
  /** A Drive-hosted file — fetchable, but only through an export URL. */
  | 'google_drive_file'
  /** A native Google document (Slides, Docs) — exportable as PDF. */
  | 'google_workspace_doc'
  /** A plain link we can request as-is. */
  | 'direct'
  /** A video host. Recorded and reachability-checked; never downloaded. */
  | 'video';

export interface ResolvedEvidenceLink {
  kind: EvidenceLinkKind;
  /** The link exactly as the team supplied it, for display and audit. */
  originalUrl: string;
  /**
   * Where to actually go for the bytes.
   *
   * The same as `originalUrl` for a direct link; an export endpoint for
   * anything Google hosts.
   */
  fetchUrl: string;
  /** Drive/Workspace file id, when the link carried one. */
  fileId: string | null;
}

const DRIVE_HOSTS = new Set(['drive.google.com', 'www.drive.google.com']);
const DOCS_HOSTS = new Set(['docs.google.com', 'www.docs.google.com']);
const VIDEO_HOSTS = new Set([
  'loom.com',
  'www.loom.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'vimeo.com',
  'www.vimeo.com',
]);

/**
 * `/file/d/<id>/view`, `/presentation/d/<id>/edit`, `/document/d/<id>` and the
 * rest all put the id in the segment after `d`.
 */
function fileIdFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  const marker = segments.indexOf('d');
  if (marker === -1) return null;
  return segments[marker + 1] ?? null;
}

/**
 * Work out what a supporting-evidence link is and where to fetch it from.
 *
 * Returns null for anything that is not a parseable http(s) URL. A team that
 * typed "coming soon" into the deck cell has given us no link, and that is a
 * different thing from a link that does not work.
 */
export function resolveEvidenceLink(raw: string | null | undefined): ResolvedEvidenceLink | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();

  if (VIDEO_HOSTS.has(host)) {
    return { kind: 'video', originalUrl: trimmed, fetchUrl: trimmed, fileId: null };
  }

  if (DRIVE_HOSTS.has(host)) {
    // `?id=` on /open and /uc, or the path form on /file/d/<id>/view.
    const fileId = url.searchParams.get('id') ?? fileIdFromPath(url.pathname);
    if (!fileId) {
      return { kind: 'direct', originalUrl: trimmed, fetchUrl: trimmed, fileId: null };
    }
    /*
     * The download endpoint rather than the viewer.
     *
     * `confirm=t` skips the virus-scan interstitial that Drive serves for
     * larger files — without it a perfectly readable deck comes back as an
     * HTML warning page and gets reported as unreadable.
     */
    return {
      kind: 'google_drive_file',
      originalUrl: trimmed,
      fetchUrl: `https://drive.google.com/uc?export=download&confirm=t&id=${encodeURIComponent(fileId)}`,
      fileId,
    };
  }

  if (DOCS_HOSTS.has(host)) {
    const fileId = fileIdFromPath(url.pathname);
    // `/presentation`, `/document`, `/spreadsheets` — the export path is the
    // same shape for each, so the type segment is reused rather than mapped.
    const docType = url.pathname.split('/').filter(Boolean)[0];
    if (!fileId || !docType) {
      return { kind: 'direct', originalUrl: trimmed, fetchUrl: trimmed, fileId: null };
    }
    return {
      kind: 'google_workspace_doc',
      originalUrl: trimmed,
      fetchUrl: `https://docs.google.com/${docType}/d/${encodeURIComponent(fileId)}/export?format=pdf`,
      fileId,
    };
  }

  return { kind: 'direct', originalUrl: trimmed, fetchUrl: trimmed, fileId: null };
}
