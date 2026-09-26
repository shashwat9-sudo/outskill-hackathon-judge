/**
 * Declared idea catalogues, by external cohort identity.
 *
 * A catalogue is looked up by the identifier the internal product uses for a
 * cohort (`cohorts.external_cohort_id`), never by a display name — names are
 * edited, identifiers are not, and applying C14's ideas to the wrong cohort is
 * exactly the mistake this indirection prevents.
 *
 * Older cohorts have no entry here. Their catalogues were seeded from
 * `fixtures/ideas.ts` and are not touched by anything in this directory.
 */

import type { IdeaCatalogue } from '../../domain/idea-catalogue';
import { AIAP_C14_CATALOGUE, AIAP_C14_EXTERNAL_COHORT_ID } from './aiap-c14';

export * from './aiap-c14';

export const COHORT_IDEA_CATALOGUES: Readonly<Record<string, IdeaCatalogue>> = {
  [AIAP_C14_EXTERNAL_COHORT_ID]: AIAP_C14_CATALOGUE,
};

/** Exact match on the external id. Case-sensitive on purpose. */
export function findCohortIdeaCatalogue(externalCohortId: string): IdeaCatalogue | null {
  return COHORT_IDEA_CATALOGUES[externalCohortId] ?? null;
}
