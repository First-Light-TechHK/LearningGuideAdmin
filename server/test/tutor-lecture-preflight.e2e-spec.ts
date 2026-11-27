import type { ProfessorAnswer } from '../src/ai/tutor/professor-qa-coverage';
import { prepareReviewedLecture } from '../src/ai/tutor/lecture-teaching';
import { lectureReferenceMarkdown } from '../src/ai/tutor/lecture-references';
import { teachingReferenceCatalogue } from '../src/ks/contract/teaching-references';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AiChatYongService } from '../src/ai/ai-chat-yong.service';
import type { AiChatLogEntry } from '../src/ai/ai-chat-logger';
import type { LlmStreamOptions } from '../src/ai/providers/llm-provider.interface';
import { compileTeachingPublication } from '../src/ai/tutor/teaching-package-publication';
import { PrismaKnowledgeClient } from '../src/ks/prisma-knowledge.client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReleasesService } from '../src/releases/releases.service';
import { TeachingCardsService } from '../src/releases/teaching-cards.service';
import { PagesService } from '../src/pages/pages.service';

const run = process.env.TUTOR_TEACHING_PG_TEST === '1' ? test : test.skip;
const evidence = {
  state:
    'A state variable is a quantitative variable used to describe a property of the system.',
  space:
    'State space is the set of all possible states of the modelled system.',
  populations:
    'Shark-tuna space uses population numbers, not positions in the ocean.',
  vector: 'An n-vector is an ordered list of n numerical components.',
  trajectory:
    'A time series is not the same representation as a trajectory through state space.',
  addition: 'Add vectors by adding corresponding components.',
};
const entries = {
  state: {
    label: ['state variable', '状态变量'],
    triggers: { en: ['state variable'], zh: ['状态变量'] },
  },
  space: {
    label: ['state space', '状态空间'],
    triggers: { en: ['state space'], zh: ['状态空间'] },
  },
  populations: {
    label: ['shark-tuna populations', '鲨鱼金枪鱼数量'],
    triggers: { en: ['shark-tuna'], zh: ['鲨鱼', '金枪鱼'] },
  },
  vector: {
    label: ['vector', '向量'],
    triggers: { en: ['vector'], zh: ['向量'] },
  },
  trajectory: {
    label: ['trajectory', '轨迹'],
    triggers: { en: ['trajectory'], zh: ['轨迹'] },
  },
  addition: {
    label: ['vector addition', '向量加法'],
    triggers: { en: ['vector addition'], zh: ['向量加法', 'v1+v2'] },
  },
};
type Topic = keyof typeof evidence;
type Case = { row: number; question: string; proposedAnswer?: string };
const cases = JSON.parse(
  readFileSync('test/fixtures/lecture-bad-cases.json', 'utf8'),
) as Case[];
const topics: Record<number, Topic> = {
  4: 'state',
  5: 'state',
  6: 'state',
  7: 'space',
  8: 'populations',
  9: 'vector',
  10: 'addition',
  11: 'trajectory',
  12: 'populations',
  13: 'populations',
  14: 'state',
};

function input(
  topic: Topic,
  special?: Case,
  payload?: Record<string, unknown>,
) {
  const labels = entries[topic].label;
  const questionText = special?.question ?? '';
  const han = (questionText.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (questionText.match(/[A-Za-z]/g) ?? []).length;
  const lang = han > 0 && latin < han * 2 ? 'zh' : 'en';
  return {
    type: special ? 'professor_qa' : 'concept',
    conceptId: topic,
    topic,
    canonicalPoint: evidence[topic],
    bilingual: {
      conceptLabel: { en: labels[0], zh: labels[1] },
      summary: { en: evidence[topic], zh: labels[1] },
      triggers: special
        ? {
            en: lang === 'en' ? [questionText] : [],
            zh: lang === 'zh' ? [questionText] : [],
          }
        : entries[topic].triggers,
    },
    useWhen: ['*'],
    doNotUseWhen: [],
    links: [],
    evidence: [evidence[topic]],
    priority: 10,
    approvedPayload: special
      ? { answerMd: special.proposedAnswer }
      : { explanation: evidence[topic], ...payload },
  };
}

run(
  'save, publish and verify all workbook Lecture cases on a disposable PostgreSQL database',
  async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Preflight requires loopback PostgreSQL');
    if (url.pathname !== '/tutor_preflight')
      throw new Error(
        'Preflight requires the disposable tutor_preflight database',
      );
    const prisma = new PrismaService();
    try {
      const owner = await prisma.course.create({
        data: {
          title: 'Modeling Life · isolated preflight',
          externalId: randomUUID(),
          aiTutorOnline: true,
          pages: {
            create: {
              title: 'Lesson 1 excerpts',
              sortOrder: 0,
              contentMd: [
                ...Object.values(evidence),
                '[Sum](refobj:vector-sum)',
              ].join('\n\n'),
            },
          },
        },
      });
      const other = await prisma.course.create({
        data: { title: 'Other course' },
      });
      const cards = new TeachingCardsService(prisma);
      const releases = new ReleasesService(
        prisma,
        { indexRelease: jest.fn().mockResolvedValue(undefined) } as never,
        {
          getImage: () =>
            Promise.resolve({
              bytes: Buffer.from([1]),
              contentType: 'image/png',
            }),
        } as never,
        compileTeachingPublication,
      );
      const image = {
        id: 'other-example',
        kind: 'image',
        label: 'Different numbers',
        value: `${randomUUID()}.png`,
        requires: ['1,3', '8,4'],
      };
      const formula = {
        id: 'vector-sum',
        kind: 'latex',
        label: 'Sum',
        value: '(2+3,5+7)=(5,12)',
        requires: ['2,5', '3,7'],
      };
      const approved = new Map<number, { id: string; revision: number }>();
      for (const topic of Object.keys(evidence) as Topic[]) {
        await cards.save(
          owner.id,
          undefined,
          undefined,
          input(
            topic,
            undefined,
            topic === 'addition' ? { refObjects: [image, formula] } : undefined,
          ),
          'preflight-editor',
        );
      }
      for (const item of cases.filter((item) => item.proposedAnswer)) {
        const record = await cards.save(
          owner.id,
          undefined,
          undefined,
          input(topics[item.row], item),
          'preflight-editor',
        );
        approved.set(item.row, record);
      }
      await expect(cards.listReferences(owner.id)).resolves.toEqual([
        image,
        formula,
      ]);
      await expect(cards.listReferences(other.id)).resolves.toEqual([]);
      const reference = approved.get(5)!;
      await expect(
        cards.save(
          other.id,
          reference.id,
          reference.revision,
          input('state', cases[1]),
          'preflight-editor',
        ),
      ).rejects.toThrow('TEACHING_CARD_NOT_FOUND');
      const first = await releases.publish(owner.id, {
        revisionNotes: 'First tested package',
      });
      await releases.setLive(owner.id, { releaseId: first.id });
      const knowledge = new PrismaKnowledgeClient(prisma, {} as never);
      const logs: AiChatLogEntry[] = [];
      const requests: LlmStreamOptions[] = [];
      const model = {
        async *stream(options: LlmStreamOptions) {
          const system = options.messages[0].content;
          if (system.startsWith('Select a single published answer')) {
            const { currentQuestion, candidates } = JSON.parse(
              options.messages[1].content,
            ) as { currentQuestion: string; candidates: ProfessorAnswer[] };
            const candidate = candidates.find(
              (row) => row.question === currentQuestion,
            );
            const need = /^(what is|什么是)/i.test(currentQuestion)
              ? 'definition'
              : 'fact';
            yield JSON.stringify(
              candidate
                ? {
                    cardId: candidate.cardId,
                    coverage: 'full',
                    conditionsMatch: true,
                    missingRequirements: [],
                    support: [
                      {
                        part: currentQuestion,
                        need,
                        provides: need,
                        excerpts: [candidate.answerMd],
                      },
                    ],
                  }
                : { coverage: 'none', missingRequirements: [] },
            );
            return;
          }
          if (system.startsWith('Classify a learner question')) {
            yield JSON.stringify({ topic: null, confidence: 0 });
            return;
          }
          requests.push(options);
          const question = options.messages.at(-1)?.content ?? '';
          if (question.includes('V1+V2')) {
            yield '逐分量相加得到 ';
            yield '[[re';
            yield 'f:vector-sum]]';
            yield '。[[ref:other-example]]';
            yield '!';
            yield '[uncurated image](/api/files/images/forged.png)';
          } else {
            yield await Promise.resolve('Course explanation.');
          }
        },
      };
      const runtime = {
        provider: 'fake',
        model: 'test-model',
        apiKey: 'unused',
        baseUrl: 'https://example.invalid',
      };
      const service = new AiChatYongService(
        knowledge,
        {
          resolveRuntime: () => Promise.resolve(runtime),
          resolveTutorRun: () =>
            Promise.resolve({
              runtime,
              dialoguePrompts: { basePrompt: 'BASE', modePrompt: 'LECTURE' },
            }),
        } as never,
        { get: () => model } as never,
        { assertAllowed: () => Promise.resolve() } as never,
        {
          writeProgress: () => Promise.resolve(),
          write: (entry: AiChatLogEntry) => {
            logs.push(entry);
            return Promise.resolve();
          },
        } as never,
      );
      const ask = async (
        message: string,
        history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
      ) => {
        let answer = '';
        for await (const text of service.streamLearnerChat({
          externalCourseId: owner.externalId!,
          message,
          mode: 'LECTURE',
          locale: 'en-GB',
          history,
        }))
          answer += text;
        return answer;
      };
      const professorAnswerInPrompt = () => {
        const prompt = requests.at(-1)!.messages[0].content;
        const field = prompt.split('FIELD 4\n')[1].split('\n\nFIELD 5')[0];
        const knowledge = JSON.parse(field) as string;
        return (JSON.parse(knowledge) as { approvedAnswer: string })
          .approvedAnswer;
      };
      for (const item of cases) {
        const answer = await ask(item.question);
        expect(logs.at(-1)?.releaseId).toBe(first.id);
        if (item.proposedAnswer) {
          expect(professorAnswerInPrompt()).toBe(item.proposedAnswer);
          expect(answer).toBe('Course explanation.');
          expect(logs.at(-1)?.teaching?.qaId).toBe(approved.get(item.row)?.id);
        } else {
          expect(requests.at(-1)?.messages[0].content).toContain(
            evidence[topics[item.row]],
          );
          expect(logs.at(-1)?.teaching?.qaId).toBeUndefined();
          expect(answer).not.toMatch(/!\[/);
        }
        if (item.row === 10) {
          expect(answer).toContain('$$(2+3,5+7)=(5,12)$$');
          expect(logs.at(-1)?.teaching?.objectIds).toEqual(['vector-sum']);
        }
      }
      expect(requests).toHaveLength(cases.length);
      await ask('Why does it matter?', [
        { role: 'user', content: cases[0].question },
      ]);
      expect(logs.at(-1)?.teaching?.topic).toBe('state');
      expect(logs.at(-1)?.teaching?.qaId).toBeUndefined();
      const changed = {
        ...cases[1],
        proposedAnswer: 'Updated approved explanation.',
      };
      const secondDraft = await cards.save(
        owner.id,
        reference.id,
        reference.revision,
        input('state', changed),
        'preflight-editor',
      );
      expect(secondDraft.approved).toEqual(secondDraft.draft);
      expect(secondDraft.approvedRevision).toBe(secondDraft.revision);
      await expect(
        cards.save(
          owner.id,
          reference.id,
          reference.revision,
          input('state', changed),
          'preflight-editor',
        ),
      ).rejects.toThrow('TEACHING_CARD_REVISION_CHANGED');
      await ask(changed.question);
      expect(professorAnswerInPrompt()).toBe(cases[1].proposedAnswer);
      const second = await releases.publish(owner.id, {
        revisionNotes: 'Saved update',
      });
      await ask(changed.question);
      expect(professorAnswerInPrompt()).toBe(cases[1].proposedAnswer);
      await releases.setLive(owner.id, { releaseId: second.id });
      await ask(changed.question);
      expect(professorAnswerInPrompt()).toBe(changed.proposedAnswer);
      await releases.setLive(owner.id, { releaseId: first.id });
      await ask(changed.question);
      expect(professorAnswerInPrompt()).toBe(cases[1].proposedAnswer);
      const page = await prisma.page.findFirstOrThrow({
        where: { courseId: owner.id },
      });
      const pages = new PagesService(prisma);
      await pages.update(page.id, {
        contentMd: page.contentMd + '\n\nA reviewed update.',
      });
      expect((await knowledge.getRelease(first.id))?.pages[0].contentMd).toBe(
        page.contentMd,
      );

      const objectDraft = (code: string) => ({
        type: 'ref_obj',
        bilingual: {
          conceptLabel: { zh: '', en: 'Addition' },
          summary: { zh: '', en: 'Add the components.' },
        },
        approvedPayload: {
          code,
          refObjects: [{ kind: 'latex', value: 'a+b' }],
        },
      });
      const refEntry = await cards.save(
        other.id,
        undefined,
        undefined,
        objectDraft('L1-F01'),
        'prof',
      );
      const link = '[old caption](refobj:' + refEntry.id + ')';
      await prisma.page.create({
        data: {
          courseId: other.id,
          title: 'Formula',
          contentMd: link,
          sortOrder: 0,
        },
      });
      const refAnswer = await cards.save(
        other.id,
        undefined,
        undefined,
        {
          type: 'professor_qa',
          approvedPayload: {
            question: '怎么相加？',
            variants: ['How do I add?'],
            keywords: ['数学'],
            answerMd: link,
          },
        },
        'prof',
      );
      const firstRefRelease = await releases.publish(other.id, {
        revisionNotes: 'original number',
      });
      await expect(
        cards.save(
          other.id,
          undefined,
          undefined,
          objectDraft('l1-f01'),
          'prof',
        ),
      ).rejects.toThrow('REFERENCE_CODE_IN_USE');
      await cards.save(
        other.id,
        refEntry.id,
        refEntry.revision,
        objectDraft('L1-EQ01'),
        'prof',
      );
      await expect(
        cards.save(
          other.id,
          undefined,
          undefined,
          objectDraft('L1-F01'),
          'prof',
        ),
      ).rejects.toThrow('REFERENCE_CODE_IN_USE');
      const secondRefRelease = await releases.publish(other.id, {
        revisionNotes: 'renumber',
      });
      for (const [releaseId, code] of [
        [firstRefRelease.id, 'L1-F01'],
        [secondRefRelease.id, 'L1-EQ01'],
      ]) {
        const frozen = (await knowledge.getRelease(releaseId))!;
        expect(frozen.pages[0].contentMd).toBe(link);
        const item = teachingReferenceCatalogue(
          frozen.teachingPackage as Record<string, unknown>,
        ).get(refEntry.id)!;
        expect(item.code).toBe(code);
        for (const q of ['解释L1-F01', '怎么相加？']) {
          const turn = prepareReviewedLecture(
            frozen,
            q,
            undefined,
            undefined,
            undefined,
            undefined,
            q === '怎么相加？'
              ? {
                  professorEvidence: {
                    cardId: refAnswer.id,
                    coverage: 'full',
                    scope: q,
                    excerpts: [link],
                    missingRequirements: [],
                  },
                }
              : undefined,
          );
          expect(turn.kind).toBe(
            q.startsWith('解释') ? 'reference' : 'reviewed',
          );
          if (!('references' in turn) || !turn.references)
            throw new Error('missing release reference');
          expect(turn.references[0].id).toBe(refEntry.id);
          expect(
            lectureReferenceMarkdown(turn.references[0], other.id),
          ).toContain(code);
        }
        for (const q of ['数学', 'How do I add?']) {
          const turn = prepareReviewedLecture(frozen, q);
          expect(turn.kind).toBe('wiki');
          expect(turn.kind === 'wiki' && turn.directCandidate).toBeUndefined();
        }
      }
    } finally {
      await prisma.$disconnect();
    }
  },
  150_000,
);
