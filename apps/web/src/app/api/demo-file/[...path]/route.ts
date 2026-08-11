import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { isDemo } from '@/lib/store';

/**
 * Demo-mode file server.
 *
 * Stands in for Supabase signed-URL downloads so the demo has working links.
 *
 * Two hard constraints:
 *   1. It only runs in demo mode.
 *   2. It serves an explicit ALLOWLIST of repository documents. There is no
 *      path traversal here because the request path is never joined to disk —
 *      it is looked up in a map. `reference-materials/` is not in the map and
 *      cannot be reached (privacy rule 6).
 */
const ALLOWED: Record<string, { file: string; type: string; download: string }> = {
  'docs/ADMIN_PLAYBOOK.md': {
    file: 'docs/ADMIN_PLAYBOOK.md',
    type: 'text/markdown; charset=utf-8',
    download: 'outskill-admin-playbook.md',
  },
  'docs/DEPLOYMENT_RUNBOOK.md': {
    file: 'docs/DEPLOYMENT_RUNBOOK.md',
    type: 'text/markdown; charset=utf-8',
    download: 'outskill-deployment-runbook.md',
  },
  'docs/PRD.md': {
    file: 'docs/PRD.md',
    type: 'text/markdown; charset=utf-8',
    download: 'outskill-scoring-rubric-guide.md',
  },
  'docs/deck/internal-briefing.html': {
    file: 'docs/deck/internal-briefing.html',
    type: 'text/html; charset=utf-8',
    download: '',
  },
};

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!isDemo()) return new NextResponse('Not found', { status: 404 });

  const { path } = await params;
  // The bucket segment is dropped; only the stored path is significant.
  const key = decodeURIComponent(path.slice(1).join('/'));
  const entry = ALLOWED[key];

  if (!entry) {
    return new NextResponse(
      `This file is not bundled with the demo.\n\nIn a real deployment it is served from private storage through a short-lived signed URL.\n\nRequested: ${key}\n`,
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  try {
    const body = await readFile(`${process.cwd()}/${entry.file}`, 'utf8');
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': entry.type,
        ...(entry.download ? { 'content-disposition': `attachment; filename="${entry.download}"` } : {}),
      },
    });
  } catch {
    return new NextResponse('File unavailable in this environment.', { status: 404 });
  }
}
