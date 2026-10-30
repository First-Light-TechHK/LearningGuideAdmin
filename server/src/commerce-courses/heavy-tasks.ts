import { Worker } from 'node:worker_threads';
import path from 'node:path';

/**
 * 在独立 worker 线程里执行导入阶段的 CPU 重活（原始素材转换、课程包解压校验），
 * 避免 165MB 级 ZIP 的同步解压/重打包阻塞事件循环导致 App Runner 健康检查失败 → 502。
 */
export function runImportWorker<T = unknown>(
  task: 'raw' | 'inspect',
  payload: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'import-worker.js'), {
      workerData: { task, payload },
    });
    let settled = false;
    worker.once(
      'message',
      (msg: { ok: boolean; result?: unknown; error?: string }) => {
        settled = true;
        if (msg.ok) resolve(msg.result as T);
        else reject(new Error(msg.error ?? 'import worker failed'));
        void worker.terminate();
      },
    );
    worker.once('error', (err) => {
      if (!settled) reject(err);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0)
        reject(new Error(`import worker exited with code ${code}`));
    });
  });
}
