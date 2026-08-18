/**
 * The assessment repository.
 *
 * Composed from three files that each own one concern: the queue (who is
 * working on what), the pipeline (what was observed), and judgment (what was
 * concluded, and who may change it). They are separate because they fail
 * differently — a queue bug loses throughput, a judgment bug loses fairness.
 *
 * The composition is exhaustive by construction: `AssessmentStore` is satisfied
 * only if all thirty-five methods are present, so a method added to the
 * interface later cannot silently go missing here.
 */

import type { AssessmentStore } from '../../store';
import type { SqlDatabase } from '../client';
import { buildQueueMethods } from './assessment-queue';
import { buildPipelineMethods } from './assessment-pipeline';
import { buildJudgmentMethods } from './assessment-judgment';

export function buildAssessmentStore(db: SqlDatabase): AssessmentStore {
  return {
    ...buildQueueMethods(db),
    ...buildPipelineMethods(db),
    ...buildJudgmentMethods(db),
  };
}
