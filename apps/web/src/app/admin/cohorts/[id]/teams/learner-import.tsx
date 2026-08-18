'use client';

import * as React from 'react';
import {
  buildImportPreview,
  buildRejectedRowsCsv,
  parseLearnerSheet,
  type ImportPreview,
} from '@ohj/shared/client';
import { AdminForm } from '@/components/admin-form';
import { Alert, Badge, Card, CardHeader, Field, Table, Td, Textarea, Th } from '@/components/ui';

/**
 * Importing the learner allocation sheet.
 *
 * The preview is the point of this screen. An import of 1,000 learners is not
 * reviewable after the fact — nobody reads 100 teams to check them — so the
 * operator has to see what will happen while they can still fix the sheet.
 *
 * Parsing runs in the browser purely so the preview is instant. The server
 * parses the same text again and re-checks the blockers; nothing here is
 * trusted (see `importLearnerAllocationAction`).
 */
export function LearnerImport({
  cohortId,
  csrfToken,
  existingGroupNumbers,
}: {
  cohortId: string;
  csrfToken: string;
  existingGroupNumbers: number[];
}) {
  const [text, setText] = React.useState('');
  const [fileName, setFileName] = React.useState<string | null>(null);

  const analysis = React.useMemo(() => {
    if (!text.trim()) return null;
    const parsed = parseLearnerSheet(text);
    if (parsed.error) return { error: parsed.error, preview: null as ImportPreview | null };
    return { error: null, preview: buildImportPreview(parsed, existingGroupNumbers) };
  }, [text, existingGroupNumbers]);

  const preview = analysis?.preview ?? null;
  const canImport = Boolean(preview?.importable) && (preview?.blockers.length ?? 0) === 0;

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  };

  return (
    <Card>
      <CardHeader
        title="Import learner allocation sheet"
        description="The sheet Outskill already maintains: Name, Email, Group, Link. Learners are grouped by their group number — one team per group. Safe to run again when a corrected sheet arrives."
      />

      <div className="space-y-4">
        <div>
          <label htmlFor="sheet" className="block text-sm font-semibold">
            Sheet file (CSV)
          </label>
          <input
            id="sheet"
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="mt-1 text-sm"
            onChange={onFile}
          />
          {fileName && <p className="mt-1 text-xs text-muted">Loaded {fileName}</p>}
        </div>

        <Field
          id="sheetText"
          label="…or paste the rows"
          hint="Copy straight out of the spreadsheet, including the header row."
        >
          {(aria) => (
            <Textarea
              {...aria}
              rows={6}
              className="font-mono text-sm"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'Name\tEmail\tGroup\tLink\nPriya Sharma\tpriya@example.com\t1\thttps://chat.whatsapp.com/…'}
            />
          )}
        </Field>

        {analysis?.error && <Alert tone="danger">{analysis.error}</Alert>}
        {preview && <Preview preview={preview} />}

        {canImport && preview && (
          <AdminForm
            action={importFromText(text, cohortId)}
            csrfToken={csrfToken}
            submitLabel={`Import ${preview.uniqueGroups} group${preview.uniqueGroups === 1 ? '' : 's'}`}
            confirm={confirmationText(preview)}
          />
        )}
      </div>
    </Card>
  );
}

/**
 * Bind the sheet text to the server action.
 *
 * The text goes over as a field rather than being held anywhere between
 * requests: an import that depends on server-side state breaks the moment the
 * operator opens the page in a second tab, which is exactly what someone does
 * when the first attempt reported problems.
 */
function importFromText(text: string, cohortId: string) {
  return async (formData: FormData) => {
    formData.set('sheetText', text);
    formData.set('cohortId', cohortId);
    const { importLearnerAllocationAction } = await import('@/server/admin-actions');
    return importLearnerAllocationAction(formData);
  };
}

function confirmationText(preview: ImportPreview): string {
  const lines = [
    `Import ${preview.uniqueGroups} group(s) and ${preview.learnerRowsRead} learner row(s)?`,
    `${preview.newTeams} new team(s), ${preview.existingTeamsMatched} already exist.`,
  ];
  if (preview.rejected.length > 0) lines.push(`${preview.rejected.length} row(s) will be skipped.`);
  return lines.join('\n');
}

function Preview({ preview }: { preview: ImportPreview }) {
  return (
    <div className="space-y-4">
      {preview.blockers.length > 0 && (
        <Alert tone="danger">
          <p className="font-semibold">Fix the sheet before importing.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Alert>
      )}

      {!preview.importable && preview.blockers.length === 0 && (
        <Alert tone="danger">No usable rows found in that sheet.</Alert>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Learner rows" value={preview.learnerRowsRead} />
        <Stat label="Groups" value={preview.uniqueGroups} />
        <Stat label="New teams" value={preview.newTeams} />
        <Stat label="Already exist" value={preview.existingTeamsMatched} />
      </dl>

      {preview.warnings.length > 0 && (
        <div className="space-y-2">
          {preview.warnings.map((warning) => (
            <Alert key={`${warning.code}-${warning.affects.join(',')}`} tone={warning.severity === 'warning' ? 'warning' : 'info'}>
              {warning.message}
            </Alert>
          ))}
        </div>
      )}

      {preview.rejected.length > 0 && (
        <div>
          <p className="text-sm font-semibold">
            {preview.rejected.length} row(s) cannot be imported
          </p>
          <p className="text-xs text-muted">
            These are skipped. Download them, fix them in the sheet, and import again — re-importing
            does not duplicate anyone.
          </p>
          <RejectedDownload preview={preview} />
          <Table caption="Rows that will be skipped">
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {preview.rejected.slice(0, 10).map((row) => (
                <tr key={row.rowNumber}>
                  <Td className="font-mono">{row.rowNumber}</Td>
                  <Td>{row.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {preview.rejected.length > 10 && (
            <p className="mt-1 text-xs text-muted">
              …and {preview.rejected.length - 10} more. The download has all of them.
            </p>
          )}
        </div>
      )}

      {preview.groups.length > 0 && (
        <details className="rounded border border-subtle p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Preview all {preview.groups.length} group(s)
          </summary>
          <Table caption="Groups that will be imported">
            <thead>
              <tr>
                <Th>Group</Th>
                <Th>Learners</Th>
                <Th>Status</Th>
                <Th>WhatsApp link</Th>
              </tr>
            </thead>
            <tbody>
              {preview.groups.map((group) => (
                <tr key={group.groupNumber}>
                  <Td className="font-mono font-semibold">{group.groupNumber}</Td>
                  <Td>
                    {group.learners.length}
                    <span className="ml-2 text-xs text-muted">
                      {group.learners
                        .slice(0, 3)
                        .map((l) => l.name)
                        .join(', ')}
                      {group.learners.length > 3 ? '…' : ''}
                    </span>
                  </Td>
                  <Td>
                    {group.existing ? (
                      <Badge tone="neutral">already exists</Badge>
                    ) : (
                      <Badge tone="success">new</Badge>
                    )}
                  </Td>
                  <Td className="text-xs text-muted">{group.whatsappLink ? 'yes' : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      )}
    </div>
  );
}

function RejectedDownload({ preview }: { preview: ImportPreview }) {
  const href = React.useMemo(() => {
    const csv = buildRejectedRowsCsv(preview.rejected);
    return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  }, [preview.rejected]);

  return (
    <a
      href={href}
      download="rows-to-fix.csv"
      className="mt-2 inline-block text-sm text-brand-text underline"
    >
      Download the rows to fix
    </a>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-subtle p-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}
