import { cleanProfessorQa } from '../../ks/contract/professor-qa-content';
import { ConflictException } from '@nestjs/common';
import { passageSource } from './course-context';
import type {
  ProfessorAnswer,
  ProfessorEvidence,
} from './professor-qa-coverage';
import type { KnowledgeRelease } from '../../ks/contract/knowledge-client';
import { selectPackageContext } from './package-selector';
import { lectureLanguage } from './lecture-language';
import {
  exhibitEvidence,
  exhibitDisplay,
  followUpKind,
  hasExplicitFormula,
  lectureExhibits,
  linkedExhibitPassage,
  matchExhibits,
} from './lecture-exhibits';
import { validatePlannerSlice, type TutorPlannerSlice } from './planner-slice';
import {
  validateReviewedTeachingPackage,
  type ReviewedTeachingCard,
} from './reviewed-package-validator';
import {
  readLectureReferences,
  type LectureReference,
} from './lecture-references';

type LectureCategory = Exclude<
  TutorPlannerSlice['turnCategory'],
  'submitted_answer'
>;

const CATEGORIES: Record<LectureCategory, string[]> = {
  factual_recall: [
    'concept',
    'source',
    'lens',
    'boundary',
    'teaching_move',
    'professor_qa',
  ],
  concept_framework: [
    'concept',
    'frame',
    'misreading',
    'distinction',
    'lens',
    'source',
    'boundary',
    'teaching_move',
    'professor_qa',
  ],
  interpretive_application: [
    'concept',
    'frame',
    'misreading',
    'distinction',
    'lens',
    'source',
    'boundary',
    'teaching_move',
    'professor_qa',
  ],
};

function normalize(text: string) {
  return text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[?？。!！]+$/u, '')
    .replace(/\s+/g, ' ');
}

function matches(question: string, term: string): boolean {
  const normalized = normalize(term);
  if (!normalized) return false;
  if (/\p{Script=Han}/u.test(normalized)) return question.includes(normalized);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`,
    'u',
  ).test(question);
}

function triggers(card: ReviewedTeachingCard) {
  const { en, zh } = cleanProfessorQa(card).bilingual.triggers;
  return [...en, ...zh];
}

function payload(card: ReviewedTeachingCard | undefined) {
  const value = card?.approvedPayload;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function prepareReviewedLecture(
  release: KnowledgeRelease,
  message: string,
  previousQuestion?: string,
  classifiedTopic?: string,
  previousObjectIds: string[] = [],
  locale?: string | null,
  semantic?: {
    professorEvidence?: ProfessorEvidence;
    rankedCards?: string[];
    collect?: (
      cards: ProfessorAnswer[],
      language: string,
      teachingIds: string[],
    ) => void;
  },
) {
  const pages = release.pages.map((page) => ({
    id: page.id ?? '',
    title: page.title,
    contentMd: page.contentMd ?? '',
    ...(page.sectionTags === undefined
      ? {}
      : { sectionTags: page.sectionTags }),
  }));
  const checked = validateReviewedTeachingPackage({
    courseId: release.courseId,
    releaseId: release.id,
    snapshot: { pages },
    candidate: release.teachingPackage,
  });
  if (!checked.valid)
    throw new ConflictException(`LECTURE_TEACHING_PACKAGE_${checked.reason}`);

  const question = normalize(message);
  const previous =
    previousQuestion &&
    /^(?:and\b|what about\b|why\b|how\b|can you elaborate\b|那|那么|为什么|怎么|还有|举个例子|继续)/u.test(
      question,
    )
      ? normalize(previousQuestion)
      : '';
  const language = lectureLanguage(message, previousQuestion, locale);
  const turnCategory: LectureCategory =
    /\b(why|apply|interpret|compare|mean here|comparar|comparación)\b|por qué|为什么|应用|如何理解|比较/u.test(
      question,
    )
      ? 'interpretive_application'
      : /\b(when|who|name|formula|how many)\b|哪年|是谁|公式/u.test(question)
        ? 'factual_recall'
        : 'concept_framework';
  const topicScores = new Map<string, number>();
  const compatible = checked.value.cards.filter(
    (card) =>
      CATEGORIES[turnCategory].includes(card.type) &&
      (card.useWhen.includes(turnCategory) || card.useWhen.includes('*')) &&
      !card.doNotUseWhen.some(
        (condition) =>
          condition === turnCategory || matches(question, condition),
      ),
  );
  const quotedSources = new Set(
    checked.value.sources
      .filter((source) => matches(question, source.content))
      .map((source) => source.anchor.id),
  );
  const fromPassage = (card: ReviewedTeachingCard) =>
    card.type === 'concept' &&
    typeof payload(card).definitionName === 'string' &&
    card.sourceSupport.some((id) => quotedSources.has(id));
  const score = (card: ReviewedTeachingCard) => {
    const entry = checked.value.glossary.find(
      (item) => item.conceptId === card.conceptId,
    );
    const cardTriggers = triggers(card);
    if (card.type === 'professor_qa')
      return (
        semantic?.professorEvidence
          ? card.cardId === semantic.professorEvidence.cardId
          : cardTriggers.some((term) => normalize(term) === question)
      )
        ? 10000
        : 0;
    if (fromPassage(card)) return 9000;
    const terms =
      card.type === 'concept' || card.type === 'distinction'
        ? [
            ...cardTriggers,
            ...(entry?.aliases.en ?? []),
            ...(entry?.aliases.zh ?? []),
            card.bilingual.conceptLabel.en,
            card.bilingual.conceptLabel.zh,
          ]
        : cardTriggers;
    const rank = semantic?.rankedCards?.indexOf(card.cardId) ?? -1;
    return Math.max(
      rank < 0 ? 0 : 100 - rank,
      ...terms.map((term) => {
        if (matches(question, term)) return 1000 + normalize(term).length;
        return previous &&
          (card.type === 'concept' || card.type === 'distinction') &&
          matches(previous, term)
          ? normalize(term).length
          : 0;
      }),
    );
  };
  for (const card of compatible) {
    const value = score(card);
    if (value && card.topic !== '*')
      topicScores.set(
        card.topic,
        Math.max(value, topicScores.get(card.topic) ?? 0),
      );
  }
  const highest = Math.max(0, ...topicScores.values());
  const topics = [...topicScores].filter(([, value]) => value === highest);
  const hints = new Map<string, Set<string>>();
  for (const card of compatible) {
    if (card.topic === '*' || card.type !== 'concept') continue;
    const concepts = hints.get(card.topic) ?? new Set<string>();
    concepts.add(card.bilingual.conceptLabel.en);
    if (card.bilingual.conceptLabel.zh)
      concepts.add(card.bilingual.conceptLabel.zh);
    hints.set(card.topic, concepts);
  }
  const topicHints = Array.from(hints, ([id, concepts]) => ({
    id,
    concepts: [...concepts].slice(0, 12),
  })).slice(0, 40);
  const inferred =
    classifiedTopic && topicHints.some((hint) => hint.id === classifiedTopic)
      ? classifiedTopic
      : null;
  const topic = inferred ?? (topics.length === 1 ? topics[0][0] : null);
  let scoped = compatible.filter(
    (card) => card.topic === '*' || card.topic === topic,
  );
  const matchesQa = compatible.filter(
    (card) => card.type === 'professor_qa' && score(card),
  );
  const qa = matchesQa.length === 1 && !inferred ? matchesQa[0] : undefined;
  scoped = scoped.filter((card) => card.type !== 'professor_qa' || card === qa);
  const applicable = (card: ReviewedTeachingCard) =>
    score(card) > 0 || (inferred === card.topic && card.type === 'concept');
  const matched = scoped.filter(applicable);
  const byPriority = (a: ReviewedTeachingCard, b: ReviewedTeachingCard) =>
    a.priority - b.priority ||
    (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0);
  const move = scoped
    .filter((card) => card.type === 'teaching_move')
    .sort(byPriority)[0];
  const lens = scoped
    .filter(
      (card) =>
        card.type === 'lens' &&
        (score(card) || payload(card).defaultForTopic === true),
    )
    .sort(byPriority)[0];
  const isStudentQuestion =
    /[?？]\s*$/u.test(message) ||
    /^(?:is|are|does|do|can|could|what|why|how)\b|^(?:是不是|是否|什么|如何|为什么)/u.test(
      question,
    );
  const detectedFrame =
    matched.find((card) => card.type === 'frame')?.cardId ?? null;
  const likelyIssue = isStudentQuestion
    ? null
    : (matched.find((card) => card.type === 'misreading')?.cardId ?? null);
  if (isStudentQuestion) {
    const possibleMisreadings = new Set(
      scoped
        .filter((card) => card.type === 'misreading')
        .map((card) => card.cardId),
    );
    scoped = scoped
      .filter((card) => card.type !== 'misreading')
      .map((card) => ({
        ...card,
        links: card.links.filter((id) => !possibleMisreadings.has(id)),
      }));
  }
  const decision = {
    turnCategory,
    detectedFrame,
    likelyIssue,
    interpretiveLensId: lens?.cardId ?? null,
    teachingMove: move?.cardId ?? 'explain',
    currentTurnContract: {
      speechAct: detectedFrame ? 'reframe' : 'explain',
      responseLanguage: language,
      requiredTerms: [],
      closeAfterResponse: true,
    },
  };
  const display = exhibitDisplay(message);
  const trace = {
    exhibitDisplay: display,
    exhibitCandidateIds: [] as string[],
    packageHash: checked.packageHash,
    topic,
    turnCategory,
    qaId: semantic?.professorEvidence ? qa?.cardId : undefined,
    selectedCardIds: [] as string[],
    sourceIds: [] as string[],
    excluded: [] as Array<{ cardId: string; reason: string }>,
    objectIds: [] as string[],
    outcome: 'no_applicable_evidence',
  };
  if (matchesQa.length > 1 || topics.length > 1)
    trace.outcome = 'ambiguous_match';
  const clarify = () => ({
    kind: 'clarify' as const,
    trace,
    topicHints: matchesQa.length > 1 || inferred ? [] : topicHints,
    directAnswer:
      language === 'zh-CN'
        ? '我还无法确定哪一部分课程材料适用。你可以告诉我具体的概念，或贴出你正在看的段落吗？'
        : 'Which course concept or passage are you referring to? That will help me use the right course material.',
  });
  const primary =
    qa ??
    matched
      .filter((card) =>
        ['concept', 'distinction', 'frame', 'source'].includes(card.type),
      )
      .sort((a, b) =>
        fromPassage(a) || fromPassage(b) || semantic?.rankedCards?.length
          ? score(b) - score(a) || byPriority(a, b)
          : byPriority(a, b),
      )[0] ??
    (likelyIssue && semantic?.rankedCards?.includes(likelyIssue)
      ? scoped.find(
          (card) =>
            card.type === 'concept' &&
            card.conceptId ===
              matched.find((issue) => issue.cardId === likelyIssue)?.conceptId,
        )
      : undefined);
  const approvedAnswer = payload(qa);
  const bodyInCard = approvedAnswer.answerMd;
  const evidence = semantic?.professorEvidence;
  if (qa && evidence && typeof bodyInCard === 'string') {
    const { coverage, excerpts } = evidence;
    const body = excerpts.join('\n\n');
    const referenced = new Set(
      [...body.matchAll(/\]\(refobj:([a-z0-9-]+)\)/g)].map((match) => match[1]),
    );
    const references = checked.value.cards
      .flatMap((card) => readLectureReferences(payload(card)))
      .filter(
        (ref) =>
          referenced.has(ref.id) &&
          ref.requires.every((term) => matches(question, term)),
      );
    return {
      kind: 'reviewed' as const,
      planner: decision,
      exhibits: [],
      focus: undefined,
      followUp: false,
      directAnswer: undefined,
      knowledge: JSON.stringify({
        approvedAnswer: body,
        coveredQuestion: evidence.scope,
        ...(coverage === 'partial'
          ? { remainingQuestionParts: evidence.missingRequirements }
          : {}),
        keyPassages: excerpts,
      }),
      outputContract: [
        'Answer the current question in the requested language. Use the professor evidence for the covered question. Preserve every relevant conclusion, explanation, condition, unit and exception. Adapt examples and length to the student.',
        coverage === 'partial'
          ? 'For the remaining parts use only supplied course material. If support is missing, say which part cannot be established.'
          : 'Quote the original wording when the student explicitly asks for it.',
      ].join(' '),
      references,
      trace: {
        ...trace,
        outcome: 'selected',
        qaCoverage: coverage,
        qaEvidenceRanges: excerpts.map((quote) => ({
          start: bodyInCard.indexOf(quote),
          length: quote.length,
        })),
        selectedCardIds: [qa.cardId],
        sourceIds: qa.sourceSupport,
      },
    };
  }
  const exhibits = lectureExhibits(checked.value.cards).filter(
    ({ ref }) =>
      display === 'auto' ||
      (display === 'image' && ref.kind === 'image') ||
      (display === 'no-image' && ref.kind === 'latex'),
  );
  const explicitFormula = hasExplicitFormula(message);
  const dependent =
    !explicitFormula &&
    /这[张幅个](?:图|公式)|那[张幅个](?:图|公式)|(?:这|那|该)(?:个|条|道)?(?:式子|等式|公式)|上图|该图|图中|图里|图上|式中|这个符号|\b(?:this|that|previous) (?:image|figure|diagram|graph|exhibit|formula|equation|expression)\b/i.test(
      message,
    );
  const referent =
    !explicitFormula &&
    (previousObjectIds.length || dependent) &&
    display !== 'words'
      ? followUpKind(message)
      : undefined;
  const objectNoun =
    referent === 'latex'
      ? '哪个公式'
      : referent === 'image'
        ? '哪张图'
        : '哪个图或公式';
  let candidates = matchExhibits(exhibits, question, previousQuestion);
  if (
    !candidates.length &&
    !dependent &&
    !/\d/u.test(question) &&
    display !== 'words'
  ) {
    candidates = exhibits.filter(
      (item) =>
        item.cardId === semantic?.rankedCards?.[0] &&
        item.ref.requires.every((term) => matches(question, term)),
    );
  }
  const mentionedFormulas = exhibits.filter(
    (item) =>
      item.ref.kind === 'latex' &&
      item.names.some((name) => name && matches(question, name)),
  );
  if (mentionedFormulas.length > 1) candidates = mentionedFormulas;
  trace.exhibitCandidateIds = candidates.map((item) => item.ref.id);
  let followUp = false;
  if (!qa && matchesQa.length === 0) {
    const named = checked.value.cards.filter((card) => {
      if (!exhibits.some((item) => item.cardId === card.cardId)) return false;
      const meta = payload(card);
      return [
        meta.code,
        ...(Array.isArray(meta.aliases) ? (meta.aliases as unknown[]) : []),
      ].some(
        (code) =>
          typeof code === 'string' &&
          matches(
            question.replace(
              /(\p{Script=Han})(?=[a-z0-9])|([a-z0-9])(?=\p{Script=Han})/gu,
              '$1$2 ',
            ),
            code,
          ),
      );
    });
    if (named.length === 1) {
      const card = named[0];
      const references = readLectureReferences(payload(card));
      const ref = references[0];
      const summary =
        card.bilingual.summary[language === 'zh-CN' ? 'zh' : 'en'] ||
        card.bilingual.summary.en;
      const showOnly =
        /^(?:(?:请|帮我|用中文|用英文|please\s+)*(?:展示|显示|看看|show\b|display\b|view\b))/i.test(
          question,
        ) &&
        !/[?？]|为什么|为何|如何|怎么|解释|说明|读出|解读|\b(why|how|explain|read|interpret)\b/i.test(
          question,
        );
      const numberOnly = question
        .replace(/^(?:请)?(?:解释|explain\s+)/i, '')
        .trim();
      const codes = [
        ref?.code,
        ...(Array.isArray(payload(card).aliases)
          ? (payload(card).aliases as string[])
          : []),
      ];
      if (
        ref &&
        summary &&
        (showOnly ||
          codes.some((code) => code && normalize(code) === numberOnly))
      )
        return {
          kind: 'reference' as const,
          trace: {
            ...trace,
            outcome: 'named_reference',
            selectedCardIds: [card.cardId],
          },
          directAnswer:
            summary + '\n\n[' + ref.label + '](refobj:' + ref.id + ')',
          references,
        };
      if (ref) candidates = exhibits.filter((item) => item.ref.id === ref.id);
    } else if (
      referent &&
      (referent !== 'any' || previousObjectIds.length) &&
      !candidates.some((item) =>
        item.names.some((name) => question.includes(normalize(name))),
      )
    ) {
      const sameKind = candidates.filter(
        (item) => referent === 'any' || item.ref.kind === referent,
      );
      candidates = exhibits.filter(
        (item) =>
          (referent === 'any' || item.ref.kind === referent) &&
          previousObjectIds.includes(item.ref.id),
      );
      if (!candidates.length) candidates = sameKind;
      if (
        !candidates.length &&
        exhibits.length &&
        dependent &&
        display === 'auto' &&
        !/[。；;]|[.!?]\s/.test(message)
      )
        return {
          ...clarify(),
          topicHints: [],
          directAnswer:
            language === 'zh-CN'
              ? `你指的是${objectNoun}？可以告诉我名称或课程内编号。`
              : 'Which exhibit do you mean? Please give its name or course number.',
        };
    }
    followUp =
      !!referent &&
      candidates.length === 1 &&
      previousObjectIds.includes(candidates[0].ref.id) &&
      !/(?:展示|显示|看看)|\bshow\b/i.test(message);
    trace.exhibitCandidateIds = candidates.map((item) => item.ref.id);
    if (
      candidates.length > 1 &&
      (display === 'image' || (dependent && referent && display === 'auto'))
    ) {
      return {
        ...clarify(),
        topicHints: [],
        directAnswer:
          (language === 'zh-CN'
            ? '你想了解其中哪一项？'
            : 'Which exhibit do you mean? ') +
          candidates
            .slice(0, 2)
            .map((item) => item.ref.label)
            .join(' / '),
      };
    }
  }
  if (semantic?.collect && !matchesQa.length && !dependent && !referent) {
    const answers = compatible.flatMap((card): ProfessorAnswer[] => {
      const { question, answerMd } = payload(card);
      return card.type === 'professor_qa' &&
        typeof question === 'string' &&
        typeof answerMd === 'string'
        ? [{ cardId: card.cardId, question, answerMd }]
        : [];
    });
    const teachingIds = compatible
      .filter(
        (card) =>
          card.type === 'concept' ||
          (!isStudentQuestion && card.type === 'misreading'),
      )
      .map((card) => card.cardId);
    if (display !== 'words')
      teachingIds.push(...exhibits.map((item) => item.cardId));
    semantic.collect(
      display === 'image' ? [] : answers,
      language,
      candidates.length ? [] : teachingIds,
    );
  }
  const focus =
    matchesQa.length === 0 && candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!primary || qa) {
    if (
      qa ||
      (!matchesQa.length &&
        (focus ||
          checked.value.cards.every(
            (card) =>
              card.type === 'ref_obj' ||
              (card.type === 'professor_qa' && payload(card).question),
          )))
    )
      return {
        kind: 'wiki' as const,
        trace,
        directCandidate:
          qa && typeof bodyInCard === 'string' && bodyInCard.trim()
            ? {
                cardId: qa.cardId,
                question:
                  typeof approvedAnswer.question === 'string'
                    ? approvedAnswer.question
                    : message,
                answerMd: bodyInCard,
              }
            : undefined,
        exhibits,
        focus,
        followUp,
        mentionedFormulas,
        wikiReferences: checked.value.cards
          .filter((card) => card.type === 'ref_obj')
          .flatMap((card) => readLectureReferences(payload(card))),
      };
    return clarify();
  }
  const teachingPackage = { ...checked.value, cards: scoped };
  const planner = validatePlannerSlice({
    candidate: decision,
    action: 'study_question',
    teachingPackage,
    defaultTeachingMove: 'explain',
  });
  if (!planner.valid) {
    trace.outcome = planner.reason;
    return clarify();
  }
  const selected = selectPackageContext({
    teachingPackage,
    planner: planner.value,
    candidateScores: scoped
      .filter((card) => applicable(card) || card.type === 'boundary')
      .map((card) => ({ cardId: card.cardId, score: score(card) ? 1 : 0 })),
    requiredCardIds: [primary.cardId],
    defaultTeachingMove: 'explain',
    minCards: 1,
    maxCards: 12,
    maxTokens: 3000,
  });
  if (!selected.valid) {
    trace.outcome = selected.reason;
    return clarify();
  }
  trace.selectedCardIds = selected.selectedCardIds;
  trace.sourceIds = selected.selectedSources.map((source) => source.anchor.id);
  trace.excluded = selected.excluded;
  trace.outcome = inferred
    ? 'selected_after_topic_classification'
    : matchesQa.length > 1
      ? 'selected_after_qa_conflict'
      : 'selected';
  const references = new Map<string, LectureReference>();
  const catalogue = new Map(
    checked.value.cards.flatMap((card) =>
      readLectureReferences(payload(card)).map(
        (item) => [item.id, item] as const,
      ),
    ),
  );
  const attach = (ref: LectureReference) => {
    if (ref.requires.every((term) => matches(question, term)))
      references.set(ref.id, ref);
  };
  const markdown = [
    ...selected.selectedCards.map((card) => payload(card).answerMd),
    ...selected.selectedSources.map((source) => source.content),
  ];
  for (const body of markdown) {
    if (typeof body !== 'string') continue;
    for (const [, id] of body.matchAll(/\]\(refobj:([a-z0-9-]+)\)/g)) {
      const ref = catalogue.get(id);
      if (ref) attach(ref);
    }
  }
  for (const card of selected.selectedCards) {
    for (const ref of readLectureReferences(payload(card)))
      if (ref.requires.length) attach(ref);
  }
  if (focus) {
    if (followUp) references.delete(focus.ref.id);
    else attach(focus.ref);
  }
  const descriptions = exhibits.filter(
    (item) =>
      item === focus ||
      references.has(item.ref.id) ||
      mentionedFormulas.includes(item),
  );
  let linkedSource: ReturnType<typeof passageSource> | undefined;
  const linkedText =
    focus &&
    linkedExhibitPassage(pages, focus.ref.id, (title, body) => {
      linkedSource = passageSource(title, null, body);
    });
  return {
    kind: 'reviewed' as const,
    linkedSource,
    exhibits,
    focus,
    followUp,
    trace,
    directAnswer: undefined,
    planner: planner.value,
    knowledge: [
      selected.knowledgeText,
      exhibitEvidence(descriptions),
      linkedText,
    ]
      .filter(Boolean)
      .join('\n\n'),
    references: [...references.values()],
    outputContract: selected.selectedCards.some(
      (card) => card.type === 'concept' && payload(card).definitionName,
    )
      ? 'Distinguish the supplementary definition from the linked script passage. Attribute quoted dialogue only to the script; explain the definition as course commentary.'
      : 'Use the approved evidence for course-specific claims.',
  };
}
