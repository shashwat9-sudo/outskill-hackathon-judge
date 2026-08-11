'use client';

import * as React from 'react';

/**
 * The deadline in the viewer's own timezone.
 *
 * Rendered client-side after mount so the server's timezone is never presented
 * as the participant's. Until then it shows the ISO date, so the value is never
 * blank and there is no layout shift.
 */
export function LocalTime({ iso }: { iso: string }) {
  const [local, setLocal] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLocal(
      new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    );
  }, [iso]);

  const zone =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;

  return (
    <p className="mt-1.5 text-sm text-ink" suppressHydrationWarning>
      <time dateTime={iso}>{local ?? new Date(iso).toISOString().slice(0, 16).replace('T', ' ')}</time>
      {local && zone && <span className="ml-1 text-muted">({zone})</span>}
    </p>
  );
}
