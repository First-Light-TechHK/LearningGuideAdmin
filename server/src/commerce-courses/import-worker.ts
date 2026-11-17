import { parentPort, workerData } from 'node:worker_threads';
import { runImportTask, type ImportTaskName } from './import-tasks';

interface WorkerInput {
  task: ImportTaskName;
  payload: Record<string, unknown>;
}

async function main() {
  const input = workerData as WorkerInput;
  try {
    const result = await runImportTask(input.task, input.payload);
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ ok: false, error: message });
  }
}

void main();
