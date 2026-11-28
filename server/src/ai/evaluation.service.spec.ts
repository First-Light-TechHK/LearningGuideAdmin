/* eslint-disable @typescript-eslint/require-await -- Async fakes match database and streaming interfaces. */
import {
  EvaluationService,
  type EvaluationDatabase,
  type EvaluationTask,
} from './evaluation.service';
import { AiChatService } from './ai-chat.service';
import { AiConfigService } from './ai-config.service';
import { createResults } from './evaluation-contract';
import type { KnowledgeClient } from '../ks/contract/knowledge-client';
import { loadTutorRelease } from './tutor/course-context';

jest.mock('./tutor/course-context', () => ({
  ...jest.requireActual<typeof import('./tutor/course-context')>(
    './tutor/course-context',
  ),
  loadTutorRelease: jest.fn(async () => ({
    id: 'r1',
    courseId: 'c1',
    versionTag: 'v1',
    pages: [{ title: 'Lesson 1', contentMd: 'Short course text' }],
    indexedChunkCount: 0,
  })),
}));

function setup() {
  const config = {
    courseId: 'c1',
    releaseId: 'r1',
    model: 'm1',
    runningSolution: 'grounded-jack' as const,
    locale: 'zh-CN' as const,
    modes: ['SOCRATIC' as const],
    kind: 'multi' as const,
  };
  const questions = [1, 2, 3].map((turn) => ({
    conversationId: 'c1',
    turn,
    question: `q${turn}`,
    notes: '',
  }));
  const task: EvaluationTask = {
    id: 't1',
    owner: 'e1',
    status: 'queued',
    config,
    questions,
    results: createResults(questions, config.modes),
    snapshots: {},
    createdAt: new Date().toISOString(),
  };
  let row = pack(task),
    locked = false;
  const client = {
    on: jest.fn(),
    off: jest.fn(),
    release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_try')) {
        const available = !locked;
        if (available) locked = true;
        return { rows: [{ locked: available }] };
      }
      locked = false;
      return { rows: [] };
    }),
  };
  const database = {
    pool: () => ({ connect: async () => client }),
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('created_at <')) return [];
      if (sql.startsWith('SELECT')) {
        if (
          sql.includes('owner=$1 AND id=$2') &&
          (values[0] !== row.owner || values[1] !== row.id)
        )
          return [];
        return [structuredClone(row)];
      }
      if (sql.includes('jsonb_build_object')) {
        if (values[1] !== row.id || values[2] !== row.owner) return [];
        row.payload.name = values[0] as string;
        return [{ id: row.id }];
      }
      if (sql.includes('SET payload=')) {
        if (row.status !== values[4]) return [];
        const updates = JSON.parse(values[0] as string) as typeof row.payload;
        if (sql.includes("- 'name'")) delete updates.name;
        row = {
          ...row,
          payload: sql.includes('payload ||')
            ? { ...row.payload, ...updates }
            : updates,
          status: values[1] as EvaluationTask['status'],
        };
        return [{ id: row.id }];
      }
      if (sql.includes('SET status=CASE')) {
        row.status =
          row.status === 'queued'
            ? 'stopped'
            : row.status === 'running'
              ? 'stopping'
              : row.status;
        return [];
      }
      if (sql.startsWith('INSERT')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  const chat = {
    streamDialogueTest: jest.fn(async function* () {
      yield 'answer';
    }),
  };
  const configs = {
    availableModels: () => ['m1'],
    resolveTutorRun: jest.fn(async () => ({
      runtime: {
        provider: 'test',
        model: 'm1',
        apiKey: 'fake-test-key',
        baseUrl: 'https://example.com',
      },
      prompts: { systemPrompt: 'Original prompt', welcomeMsg: '' },
      dialoguePrompts: {
        basePrompt: 'Original base',
        modePrompt: 'Original mode',
      },
    })),
  };
  const service = new EvaluationService(
    database as unknown as EvaluationDatabase,
    chat as unknown as AiChatService,
    configs as unknown as AiConfigService,
    {} as KnowledgeClient,
  );
  const run = () => (service as unknown as { tick(): Promise<void> }).tick();
  return {
    service,
    run,
    chat,
    database,
    get: () => unpack(row),
    set: (t: EvaluationTask) => {
      row = pack(t);
    },
  };
}
function pack(task: EvaluationTask) {
  const { id, owner, status, ...payload } = task;
  return { id, owner, status, payload };
}
function unpack(row: ReturnType<typeof pack>): EvaluationTask {
  return { ...row.payload, id: row.id, owner: row.owner, status: row.status };
}

jest.setTimeout(20000);
describe('evaluation execution', () => {
  it.each(['grounded-jack', 'dialogue-yong'] as const)(
    'rejects a large unindexed release before inserting a batch (%s)',
    async (runningSolution) => {
      const env = setup();
      const { config, questions } = env.get();
      jest.mocked(loadTutorRelease).mockResolvedValueOnce({
        id: 'r1',
        courseId: 'c1',
        versionTag: 'v1',
        pages: [
          { title: 'Lesson 1', contentMd: 'A long chapter. '.repeat(2000) },
        ],
        indexedChunkCount: 0,
      });
      await expect(
        env.service.create('e1', { ...config, runningSolution }, questions),
      ).rejects.toThrow('重建索引');
      expect(env.database.query).not.toHaveBeenCalled();
    },
  );

  it('allows a small release to use the full snapshot without an index', async () => {
    const env = setup();
    const { config, questions } = env.get();
    await expect(env.service.create('e1', config, questions)).resolves.toEqual(
      expect.objectContaining({ id: 't1' }),
    );
    expect(env.database.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ai_evaluation_tasks'),
      expect.any(Array),
    );
  });

  it('preserves the original prompts without appending language instructions or storing keys', async () => {
    const env = setup();
    const snapshots = await env.service.snapshot(env.get().config);
    expect(snapshots.SOCRATIC?.prompts.systemPrompt).toBe('Original prompt');
    expect(snapshots.SOCRATIC?.dialoguePrompts.modePrompt).toBe(
      'Original mode',
    );
    expect(snapshots.SOCRATIC?.runtime).not.toHaveProperty('apiKey');
  });
  it('saves complete turns and uses only the same conversation history', async () => {
    const env = setup();
    await env.run();
    expect(env.get().status).toBe('completed');
    expect(env.get().results.every((r) => r.status === 'success')).toBe(true);
    const calls = env.chat.streamDialogueTest.mock.calls as unknown as Array<
      Array<{ history: unknown[] }>
    >;
    expect(calls[0][0].history).toHaveLength(0);
    expect(calls[2][0].history).toHaveLength(4);
  });

  it('preserves a new task name while writing progress from an older worker snapshot', async () => {
    const env = setup();
    env.set({ ...env.get(), name: 'Old name' });
    env.chat.streamDialogueTest.mockImplementationOnce(async function* () {
      await expect(
        env.service.rename('e1', 't1', '  第 1 课回归  '),
      ).resolves.toEqual({
        id: 't1',
        name: '第 1 课回归',
      });
      yield 'answer';
    });
    await env.run();
    const saved = await env.service.get('e1', 't1');
    expect(saved.name).toBe('第 1 课回归');
    expect(saved.status).toBe('completed');
  });

  it('rejects invalid names and tasks owned by another employee', async () => {
    const env = setup();
    for (const name of [' ', 'x'.repeat(81), 'First\nSecond', 42]) {
      await expect(env.service.rename('e1', 't1', name)).rejects.toThrow(
        '任务名称',
      );
    }
    expect(env.database.query).not.toHaveBeenCalled();
    await expect(
      env.service.rename('e2', 't1', 'Another name'),
    ).rejects.toThrow('TASK_NOT_FOUND');
    expect(env.get().name).toBeUndefined();
  });
  it('stops mid-answer, preserves partial content, fails remaining turns and ignores late completion', async () => {
    const env = setup();
    env.chat.streamDialogueTest.mockImplementation(async function* () {
      yield 'partial';
      await env.service.stop('e1', 't1');
      yield 'late';
    });
    await env.run();
    expect(env.get().status).toBe('stopped');
    expect(env.get().results.map((r) => r.status)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(env.get().results[0].error).toBe('USER_STOPPED_INCOMPLETE');
    expect(env.get().results[0].answer).toContain('partial');
    expect(env.chat.streamDialogueTest).toHaveBeenCalledTimes(1);
  });
  it('stopping a queued job makes all pending turns failed and denies other owners', async () => {
    const env = setup();
    await expect(env.service.get('e2', 't1')).rejects.toThrow('TASK_NOT_FOUND');
    await env.service.stop('e1', 't1');
    expect(env.get().status).toBe('stopped');
    expect(
      env.get().results.every((r) => r.error === 'USER_STOPPED_NOT_EXECUTED'),
    ).toBe(true);
  });
  it('reuses the created task on concurrent replays of a restart key', async () => {
    const env = setup();
    env.set({ ...env.get(), status: 'completed' });
    const originalQuery = env.database.query.getMockImplementation()!;
    const inserted = new Map<
      unknown,
      { id: string; owner: string; status: string; payload: unknown }
    >();
    env.database.query.mockImplementation(async (sql, values = []) => {
      if (sql.startsWith('INSERT')) {
        const key = values[5];
        if (inserted.has(key)) return [];
        const row = {
          id: String(values[0]),
          owner: String(values[1]),
          status: String(values[2]),
          payload: JSON.parse(String(values[3])) as unknown,
        };
        inserted.set(key, row);
        return [{ id: row.id }];
      }
      if (sql.includes('submission_key=$2')) {
        const row = inserted.get(values[1]);
        return row ? [{ id: row.id }] : [];
      }
      const row = Array.from(inserted.values()).find(
        (item) => item.id === values[1],
      );
      if (row && sql.includes('owner=$1 AND id=$2')) return [row];
      return originalQuery(sql, values);
    });
    const key = '07983c97-0d51-4022-a973-ef2dd1a0492c';
    const [first, replay] = await Promise.all([
      env.service.restart('e1', 't1', key),
      env.service.restart('e1', 't1', key),
    ]);
    expect(replay.id).toBe(first.id);
    expect(inserted.size).toBe(1);
    await expect(
      env.service.restart('e1', 't1', 'b273224d-5ba7-4d13-ae15-33b623220b7f'),
    ).resolves.not.toHaveProperty('id', first.id);
    expect(inserted.size).toBe(2);
  });
  it('marks interrupted turns failed after restart and fails dependent turns', async () => {
    const env = setup(),
      task = env.get();
    task.status = 'running';
    task.results[0].status = 'running';
    env.set(task);
    await env.run();
    expect(env.get().results[0].error).toBe('EXECUTION_INTERRUPTED');
    expect(env.get().results[1].error).toBe('PREVIOUS_TURN_FAILED');
    expect(env.chat.streamDialogueTest).not.toHaveBeenCalled();
  });
  it('does not execute a second worker while the global database lock is held', async () => {
    const env = setup();
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.chat.streamDialogueTest.mockImplementation(async function* () {
      started();
      await finish;
      yield 'ok';
    });
    const running = env.run();
    await ready;
    await env.run();
    expect(env.chat.streamDialogueTest).toHaveBeenCalledTimes(1);
    release();
    await running;
  });
});
