'use client';

import * as React from 'react';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { lookupReceiptAction, type ReceiptLookupResult } from '@/server/admin-actions';

/**
 * Find a submission by its receipt ID.
 *
 * The one thing a learner can quote in a support message. Without this, "my
 * receipt says OHJ-7K2M-4Q8P" is unanswerable without scanning a list of five
 * hundred, which on deadline evening is the difference between resolving a
 * query and not.
 */
export function ReceiptLookup({ csrfToken }: { csrfToken: string }) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<ReceiptLookupResult | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setResult(null);
    const formData = new FormData(event.currentTarget);
    formData.set('csrf', csrfToken);
    setResult(await lookupReceiptAction(formData));
    setPending(false);
  };

  return (
    <Card className="mb-8" testId="receipt-lookup">
      <h2 className="text-lg font-bold">Find a submission by receipt ID</h2>
      <p className="mt-1 text-sm text-muted">
        Teams get a receipt ID when they submit. It is the only identifier they can quote back.
      </p>

      <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3">
        <Field id="receiptId" label="Receipt ID">
          {(aria) => (
            <Input
              {...aria}
              name="receiptId"
              placeholder="OHJ-7K2M-4Q8P"
              autoComplete="off"
              spellCheck={false}
              className="w-[16rem] font-mono"
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" loading={pending}>
          Find
        </Button>
      </form>

      {result && (
        <Alert tone={result.found ? 'success' : 'info'} className="mt-4" testId="receipt-result">
          {result.found ? (
            <>
              <p className="font-semibold">
                Group {result.groupNumber} — {result.productName ?? 'no product name yet'}
              </p>
              <p className="mt-1">Submitted {result.submittedAtLabel}.</p>
              <a
                href={`/admin/submissions/${result.submissionId}`}
                className="mt-2 inline-block font-semibold text-brand-text underline underline-offset-4"
              >
                Open the submission
              </a>
            </>
          ) : (
            <p>{result.message}</p>
          )}
        </Alert>
      )}
    </Card>
  );
}
