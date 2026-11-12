import type { AiConfigService } from './ai-config.service';
import type { EvaluationLocale } from './evaluation-contract';
type Run = Awaited<ReturnType<AiConfigService['resolveTutorRun']>>;
export type EvaluationSnapshot = Omit<Run, 'runtime'> & {
  runtime: Omit<Run['runtime'], 'apiKey'>;
};
export interface EvaluationExecution {
  locale?: EvaluationLocale;
  batch: boolean;
  snapshot: EvaluationSnapshot;
}
