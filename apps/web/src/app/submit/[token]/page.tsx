import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { PARTICIPANT_SESSION_COOKIE } from '@ohj/shared';
import { getStoreAsync, isDemo } from '@/lib/store';
import { Wordmark } from '@/components/ui';
import { InviteEntry } from './invite-entry';

export const dynamic = 'force-dynamic';

/**
 * Invite-token shortcut. Demo mode only.
 *
 * Learners use the one common `/submit` URL with a group number and access
 * code. This route exists so the demo home page can open a team directly, and
 * it is unavailable in production.
 *
 * That gate is a security decision, not tidiness. An invite token grants the
 * same access as an access code while bypassing everything that protects one:
 * the code is Argon2id-hashed, rate-limited, locks out after eight wrong
 * attempts, and is versioned so regenerating it signs everyone out. A token in
 * a URL has none of that, and a URL is the thing that gets forwarded into a
 * group chat. Two doors where the product needs one, and only one of them was
 * being watched.
 *
 * It skips only the code step — the "who is editing" step is the same one the
 * common flow uses, so a session is never opened without a name attached and
 * the demo exercises the real path.
 */
export default async function InviteShortcutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  // Indistinguishable from a route that never existed. In production this is
  // the only outcome, whatever the token.
  if (!isDemo()) notFound();

  const { token } = await params;
  const store = await getStoreAsync();

  // Already signed in on this device: the invite has nothing more to offer.
  const existing = (await cookies()).get(PARTICIPANT_SESSION_COOKIE)?.value;
  if (existing && (await store.participant.resolveSession(existing))) {
    redirect('/submit/portal');
  }

  // Checked on load rather than on submit, so a dead link fails immediately
  // instead of after someone has typed their name. Unknown, revoked and expired
  // tokens are all a plain 404 — indistinguishable from each other and from a
  // route that never existed.
  const team = await store.participant.resolveInviteTeam(token);
  if (!team) notFound();

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center px-4 py-4 sm:px-6">
          <Wordmark subtitle="AI Accelerator" />
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-text">
          Group {team.groupNumber}
        </p>
        <h1 className="mt-2 text-3xl font-bold text-ink sm:text-4xl">Open your team submission</h1>
        <p className="mt-3 max-w-prose text-base text-muted">
          This link opens your team&rsquo;s entry directly. Tell us who is editing so your team can
          see who changed what.
        </p>

        <InviteEntry token={token} />
      </main>
    </div>
  );
}
