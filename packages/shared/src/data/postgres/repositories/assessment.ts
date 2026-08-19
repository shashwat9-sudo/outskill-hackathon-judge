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
import type { StorageAdapter } from '../storage';
import { buildEvidenceStore } from './evidence';
import { buildJudgingInputStore } from './judging-input';
import { buildQueueMethods } from './assessment-queue';
import { buildPipelineMethods } from './assessment-pipeline';
import { buildJudgmentMethods } from './assessment-judgment';

export function buildAssessmentStore(db: SqlDatabase, storage: StorageAdapter): AssessmentStore {
  return {
    ...buildQueueMethods(db),
    ...buildPipelineMethods(db),
    ...buildJudgmentMethods(db),
    // Evidence needs a Storage credential to mint an upload URL, which is why
    // it lives on the web app's store and why the worker asks over HTTP rather
    // than doing it itself.
    ...buildEvidenceStore(db, storage),
    ...buildJudgingInputStore(db),
  };
}
