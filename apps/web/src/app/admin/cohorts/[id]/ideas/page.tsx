import { notFound } from 'next/navigation';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { deactivateIdeaAction, saveIdeaAction } from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import { Badge, Card, CardHeader, Checkbox, Field, Input, Textarea } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Idea configuration.
 *
 * Ideas belong to a cohort, not to the system (ADR-013) — editing next
 * cohort's ideas cannot retroactively change how a past cohort was judged.
 *
 * `minimumCoreFlow` is the field that matters most: it is what the test planner
 * treats as the bar a compliant implementation must clear.
 */
export default async function IdeasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAdmin();
  const store = getStore();

  const cohort = await store.cohorts.getCohort(id);
  if (!cohort) notFound();
  const ideas = await store.cohorts.listIdeas(id, { includeInactive: true });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Approved ideas</h1>
        <p className="text-sm text-muted">
          {cohort.name} · participants choose exactly one of these. Deactivating an idea keeps it
          resolvable for submissions that already chose it.
        </p>
      </div>

      {ideas.map((idea) => (
        <Card key={idea.id}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                {idea.title}
                {!idea.isActive && <Badge tone="neutral">inactive</Badge>}
              </span>
            }
            description={idea.description}
            level={3}
          />

          <AdminForm action={saveIdeaAction} csrfToken={session.csrfToken} submitLabel="Save idea">
            <input type="hidden" name="ideaId" value={idea.id} />
            <input type="hidden" name="cohortId" value={cohort.id} />

            <div className="grid gap-5 sm:grid-cols-2">
              <Field id={`title-${idea.id}`} label="Title" required>
                {(aria) => <Input {...aria} name="title" defaultValue={idea.title} />}
              </Field>
              <Field id={`slug-${idea.id}`} label="Slug" required>
                {(aria) => <Input {...aria} name="slug" defaultValue={idea.slug} />}
              </Field>
            </div>

            <div className="mt-5 space-y-5">
              <Field id={`description-${idea.id}`} label="Description" hint="Shown to participants.">
                {(aria) => <Textarea {...aria} name="description" rows={2} defaultValue={idea.description} />}
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id={`targetUser-${idea.id}`} label="Target user">
                  {(aria) => <Textarea {...aria} name="targetUser" rows={2} defaultValue={idea.targetUser} />}
                </Field>
                <Field id={`expectedUseCase-${idea.id}`} label="Expected basic use case">
                  {(aria) => (
                    <Textarea {...aria} name="expectedUseCase" rows={2} defaultValue={idea.expectedUseCase} />
                  )}
                </Field>
              </div>

              <Field
                id={`minimumCoreFlow-${idea.id}`}
                label="Minimum core flow"
                hint="One step per line. This is the bar a working implementation must clear, and it drives the generated test plan."
              >
                {(aria) => (
                  <Textarea
                    {...aria}
                    name="minimumCoreFlow"
                    rows={5}
                    defaultValue={idea.minimumCoreFlow.join('\n')}
                  />
                )}
              </Field>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  id={`expectedEntities-${idea.id}`}
                  label="Expected entities"
                  hint="One per line."
                >
                  {(aria) => (
                    <Textarea
                      {...aria}
                      name="expectedEntities"
                      rows={4}
                      defaultValue={idea.expectedEntities.join('\n')}
                    />
                  )}
                </Field>
                <Field id={`aiOpportunity-${idea.id}`} label="Possible AI opportunity">
                  {(aria) => (
                    <Textarea {...aria} name="aiOpportunity" rows={4} defaultValue={idea.aiOpportunity} />
                  )}
                </Field>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field id={`allowedScope-${idea.id}`} label="Allowed scope">
                  {(aria) => <Textarea {...aria} name="allowedScope" rows={3} defaultValue={idea.allowedScope} />}
                </Field>
                <Field
                  id={`unsafe-${idea.id}`}
                  label="Unsafe or prohibited interpretations"
                  hint="Constrains what automated testing will do with this idea."
                >
                  {(aria) => (
                    <Textarea
                      {...aria}
                      name="unsafeInterpretations"
                      rows={3}
                      defaultValue={idea.unsafeInterpretations}
                    />
                  )}
                </Field>
              </div>

              <div className="flex flex-wrap items-end gap-6">
                <Field id={`displayOrder-${idea.id}`} label="Display order">
                  {(aria) => (
                    <Input
                      {...aria}
                      name="displayOrder"
                      type="number"
                      min={0}
                      defaultValue={idea.displayOrder}
                      className="w-24"
                    />
                  )}
                </Field>
                <Checkbox
                  id={`isActive-${idea.id}`}
                  name="isActive"
                  label="Active — participants can choose this idea"
                  defaultChecked={idea.isActive}
                />
              </div>
            </div>
          </AdminForm>

          {idea.isActive && (
            <div className="mt-4 border-t border-line pt-4">
              <AdminForm
                action={deactivateIdeaAction}
                csrfToken={session.csrfToken}
                submitLabel="Deactivate"
                submitVariant="secondary"
                confirm={`Deactivate “${idea.title}”? Teams will no longer be able to choose it.`}
              >
                <input type="hidden" name="ideaId" value={idea.id} />
                <input type="hidden" name="cohortId" value={cohort.id} />
              </AdminForm>
            </div>
          )}
        </Card>
      ))}

      <Card>
        <CardHeader title="Add an idea" level={3} />
        <AdminForm action={saveIdeaAction} csrfToken={session.csrfToken} submitLabel="Create idea">
          <input type="hidden" name="cohortId" value={cohort.id} />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="new-title" label="Title" required>
              {(aria) => <Input {...aria} name="title" />}
            </Field>
            <Field id="new-slug" label="Slug" required>
              {(aria) => <Input {...aria} name="slug" placeholder="my-new-idea" />}
            </Field>
          </div>
          <div className="mt-5 space-y-5">
            <Field id="new-description" label="Description">
              {(aria) => <Textarea {...aria} name="description" rows={2} />}
            </Field>
            <Field id="new-minimumCoreFlow" label="Minimum core flow" hint="One step per line.">
              {(aria) => <Textarea {...aria} name="minimumCoreFlow" rows={4} />}
            </Field>
            <Checkbox id="new-isActive" name="isActive" label="Active" defaultChecked />
          </div>
        </AdminForm>
      </Card>
    </div>
  );
}
