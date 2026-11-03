import { HelpdeskError } from '../portalHelpdeskClient';
import type { FaqActor } from './faqContracts';
import type { FaqMapNode } from './faqMap';
import type {
  FaqMapRepository,
  MapNodeInput,
  PlacementInput,
} from './faqMapRepository';
import type { FaqRepository } from './faqRepository';
import { ATTRIBUTES, type Attribute } from './locator/questionType';

/**
 * 从结构文件导入流程树与对象表（设计文档「Helpdesk 定位方式对比」第三节，项目文件 faq-library/v3.1/map/）：
 * skeleton.json（阶段与步骤、对象、属性）+ placements/<卡的 key>.json（每张卡一个小文件）。经仓储层，
 * 按 key 幂等：再跑一次只改有变化的。格子 = rules.<对象>.<属性>，由挂载带出来。岔子两种写法：
 * v2（2026-11-02 起，按代码建的 SOP 树）写在 skeleton 的步骤里（steps[].deviations，没有卡的岔子也建），
 * 挂载只写岔子的 key；v1 把岔子的 key 与文字写在挂载里。不建发布版本：结构随下一次「发布新版本」冻结进快照。
 * 换了一版树（key 改名、步骤换阶段、v1 的岔子不要了）用 pruneFaqMap 先把种子里没有的节点拿掉。
 */

type Labels = { labelEn: string; labelZh: string };
type DeviationText = { key: string; en: string; zh: string };

export type MapPlace =
  | { node: 'step'; step: string }
  | { node: 'deviation'; step: string; deviation: DeviationText }
  | { node: 'cell'; object: string; attribute: Attribute };

export type MapSeed = {
  stages: (Labels & {
    key: string;
    steps: (Labels & { key: string; deviations: DeviationText[] })[];
  })[];
  /** stage = 对象所属阶段的 key。对象的 key 不带 rules.（导入时加上）。 */
  objects: (Labels & { key: string; stage: string })[];
  attributes: (Labels & { key: Attribute })[];
  placements: { faqKey: string; primary: MapPlace; secondary: MapPlace[] }[];
};

export type MapSeedReport = {
  nodes: { created: string[]; changed: string[]; unchanged: number };
  placements: { cards: number; changed: number; missingCards: string[] };
};

const invalid = (message: string) =>
  new HelpdeskError(400, 'INVALID_INPUT', message);

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw invalid(`${what} needs a text`);
  return value.trim();
};

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`${what} is not an object`);
  return value as Record<string, unknown>;
};

const list = (value: unknown, what: string): unknown[] => {
  if (!Array.isArray(value)) throw invalid(`${what} is not a list`);
  return value;
};

/** 种子里的步骤、skeleton 里写好的岔子（key → 所在步骤与文字）、对象：挂载按这些核对。 */
type SeedKeys = {
  steps: ReadonlySet<string>;
  deviations: ReadonlyMap<string, { step: string; text: DeviationText }>;
  objects: ReadonlySet<string>;
};

function place(raw: unknown, what: string, keys: SeedKeys): MapPlace {
  const body = record(raw, what);
  if (body.node === 'step') {
    const step = text(body.step, `${what}.step`);
    if (!keys.steps.has(step))
      throw invalid(`${what}: step ${step} is not in the skeleton`);
    return { node: 'step', step };
  }
  if (body.node === 'deviation' && typeof body.deviation === 'string') {
    const key = text(body.deviation, `${what}.deviation`);
    const known = keys.deviations.get(key);
    if (!known)
      throw invalid(`${what}: deviation ${key} is not in the skeleton`);
    return { node: 'deviation', step: known.step, deviation: known.text };
  }
  if (body.node === 'deviation') {
    const deviation = record(body.deviation, `${what}.deviation`);
    const step = text(body.step, `${what}.step`);
    if (!keys.steps.has(step))
      throw invalid(`${what}: step ${step} is not in the skeleton`);
    return {
      node: 'deviation',
      step,
      deviation: {
        key: text(deviation.key, `${what}.deviation.key`),
        en: text(deviation.en, `${what}.deviation.en`),
        zh: text(deviation.zh, `${what}.deviation.zh`),
      },
    };
  }
  if (body.node === 'cell') {
    const attribute = text(body.attribute, `${what}.attribute`);
    if (!(ATTRIBUTES as readonly string[]).includes(attribute))
      throw invalid(`${what}: unknown attribute ${attribute}`);
    const object = text(body.object, `${what}.object`);
    if (!keys.objects.has(object))
      throw invalid(`${what}: object ${object} is not in the skeleton`);
    return { node: 'cell', object, attribute: attribute as Attribute };
  }
  throw invalid(`${what}: node must be step, deviation or cell`);
}

/**
 * 读结构文件（宽松读：不认识的字段忽略）。skeleton：{ stages: [{ key, labelEn, label | labelZh,
 * steps: [{ key, labelEn, label | labelZh, deviations?: [{ key, en | labelEn, zh | labelZh }] }] }],
 * objects: [{ key, labelEn, label | labelZh, stage }], attributes: [{ key, labelEn, label | labelZh }] }；
 * 对象的 stage 可以写阶段 key，也可以写 S1、S2…（按 stages 的顺序）。
 * 每个挂载文件：{ key（卡的 key）, primary, secondary? }；岔子写 { node: 'deviation', deviation: '<key>' }
 * （skeleton 里的）或 v1 的 { node, step, deviation: { key, en, zh } }。步骤、岔子、对象不在 skeleton 里 → 400。
 */
export function parseMapSeed(
  skeleton: unknown,
  placementFiles: readonly unknown[],
): MapSeed {
  const body = record(skeleton, 'skeleton');
  const labels = (raw: Record<string, unknown>, what: string): Labels => ({
    labelEn: text(raw.labelEn, `${what}.labelEn`),
    labelZh: text(raw.labelZh ?? raw.label, `${what}.labelZh`),
  });
  const stages = list(body.stages, 'stages').map((raw, i) => {
    const stage = record(raw, `stages[${i}]`);
    return {
      key: text(stage.key, `stages[${i}].key`),
      ...labels(stage, `stages[${i}]`),
      steps: list(stage.steps, `stages[${i}].steps`).map((rawStep, j) => {
        const step = record(rawStep, `stages[${i}].steps[${j}]`);
        const where = `stages[${i}].steps[${j}]`;
        return {
          key: text(step.key, `${where}.key`),
          ...labels(step, where),
          deviations: list(step.deviations ?? [], `${where}.deviations`).map(
            (rawDeviation, k) => {
              const deviation = record(
                rawDeviation,
                `${where}.deviations[${k}]`,
              );
              return {
                key: text(deviation.key, `${where}.deviations[${k}].key`),
                en: text(
                  deviation.en ?? deviation.labelEn,
                  `${where}.deviations[${k}].en`,
                ),
                zh: text(
                  deviation.zh ?? deviation.labelZh ?? deviation.label,
                  `${where}.deviations[${k}].zh`,
                ),
              };
            },
          ),
        };
      }),
    };
  });
  const stageKey = (raw: string) => {
    const numbered = /^S(\d+)$/.exec(raw);
    const key = numbered ? stages[Number(numbered[1]) - 1]?.key : raw;
    if (!key || !stages.some((stage) => stage.key === key))
      throw invalid(`Unknown stage ${raw}`);
    return key;
  };
  const objects = list(body.objects, 'objects').map((raw, i) => {
    const object = record(raw, `objects[${i}]`);
    return {
      key: text(object.key, `objects[${i}].key`),
      ...labels(object, `objects[${i}]`),
      stage: stageKey(text(object.stage, `objects[${i}].stage`)),
    };
  });
  const attributes = list(body.attributes, 'attributes').map((raw, i) => {
    const attribute = record(raw, `attributes[${i}]`);
    const key = text(attribute.key, `attributes[${i}].key`);
    if (!(ATTRIBUTES as readonly string[]).includes(key))
      throw invalid(`Unknown attribute ${key}`);
    return { key: key as Attribute, ...labels(attribute, `attributes[${i}]`) };
  });
  const steps = stages.flatMap((stage) => stage.steps);
  const keys: SeedKeys = {
    steps: new Set(steps.map((step) => step.key)),
    deviations: new Map(
      steps.flatMap((step) =>
        step.deviations.map(
          (d) => [d.key, { step: step.key, text: d }] as const,
        ),
      ),
    ),
    objects: new Set(objects.map((object) => object.key)),
  };
  const all = [
    ...stages.map((s) => s.key),
    ...steps.map((s) => s.key),
    ...keys.deviations.keys(),
  ];
  const twice = all.find((key, i) => all.indexOf(key) !== i);
  if (twice !== undefined) throw invalid(`${twice} is in the skeleton twice`);
  if (steps.flatMap((s) => s.deviations).length !== keys.deviations.size)
    throw invalid('A deviation key is in the skeleton twice');
  const placements = placementFiles.map((raw, i) => {
    const file = record(raw, `placements[${i}]`);
    return {
      faqKey: text(file.key, `placements[${i}].key`),
      primary: place(file.primary, `placements[${i}].primary`, keys),
      secondary: list(file.secondary ?? [], `placements[${i}].secondary`).map(
        (s, j) => place(s, `placements[${i}].secondary[${j}]`, keys),
      ),
    };
  });
  return { stages, objects, attributes, placements };
}

const objectKey = (object: string) => `rules.${object}`;
const cellKey = (object: string, attribute: Attribute) =>
  `${objectKey(object)}.${attribute}`;

/** 一个挂载落在哪个节点（key）。 */
function nodeKeyOf(p: MapPlace): string {
  if (p.node === 'step') return p.step;
  if (p.node === 'deviation') return p.deviation.key;
  return cellKey(p.object, p.attribute);
}

/** 种子里全部节点（父节点在前）：skeleton 的阶段、步骤、对象、岔子，再加挂载带出来的格子与 v1 岔子。 */
export function mapSeedNodes(seed: MapSeed): MapNodeInput[] {
  const nodes: MapNodeInput[] = [];
  const base = {
    parentKey: null,
    stageKey: null,
    attribute: null,
  } as const;
  seed.stages.forEach((stage, i) => {
    nodes.push({
      ...base,
      key: stage.key,
      kind: 'stage',
      position: i,
      labelEn: stage.labelEn,
      labelZh: stage.labelZh,
    });
    stage.steps.forEach((step, j) =>
      nodes.push({
        ...base,
        key: step.key,
        kind: 'step',
        parentKey: stage.key,
        position: j,
        labelEn: step.labelEn,
        labelZh: step.labelZh,
      }),
    );
  });
  seed.objects.forEach((object, i) =>
    nodes.push({
      ...base,
      key: objectKey(object.key),
      kind: 'object',
      stageKey: object.stage,
      position: i,
      labelEn: object.labelEn,
      labelZh: object.labelZh,
    }),
  );
  for (const stage of seed.stages)
    for (const step of stage.steps)
      step.deviations.forEach((deviation, k) =>
        nodes.push({
          ...base,
          key: deviation.key,
          kind: 'deviation',
          parentKey: step.key,
          position: k,
          labelEn: deviation.en,
          labelZh: deviation.zh,
        }),
      );
  const attributeLabel = new Map(seed.attributes.map((a) => [a.key, a]));
  const seen = new Set(nodes.map((node) => node.key));
  const places = seed.placements.flatMap((p) => [p.primary, ...p.secondary]);
  for (const p of places) {
    const key = nodeKeyOf(p);
    if (seen.has(key) || p.node === 'step') continue;
    seen.add(key);
    if (p.node === 'deviation')
      nodes.push({
        ...base,
        key,
        kind: 'deviation',
        parentKey: p.step,
        position: 0,
        labelEn: p.deviation.en,
        labelZh: p.deviation.zh,
      });
    else {
      const label = attributeLabel.get(p.attribute);
      nodes.push({
        ...base,
        key,
        kind: 'cell',
        parentKey: objectKey(p.object),
        attribute: p.attribute,
        position: ATTRIBUTES.indexOf(p.attribute),
        labelEn: label?.labelEn ?? p.attribute,
        labelZh: label?.labelZh ?? p.attribute,
      });
    }
  }
  return nodes;
}

export async function seedFaqMap(
  deps: {
    map: Pick<FaqMapRepository, 'upsertNode' | 'setPlacements'>;
    faqs: Pick<FaqRepository, 'getByKey'>;
  },
  seed: MapSeed,
  actor: FaqActor,
): Promise<MapSeedReport> {
  const report: MapSeedReport = {
    nodes: { created: [], changed: [], unchanged: 0 },
    placements: { cards: 0, changed: 0, missingCards: [] },
  };
  for (const input of mapSeedNodes(seed)) {
    const result = await deps.map.upsertNode(input, actor);
    if (result.created) report.nodes.created.push(input.key);
    else if (result.changed) report.nodes.changed.push(input.key);
    else report.nodes.unchanged += 1;
  }
  for (const p of seed.placements) {
    const faq = await deps.faqs.getByKey(p.faqKey);
    if (!faq) {
      report.placements.missingCards.push(p.faqKey);
      continue;
    }
    const wanted: PlacementInput[] = [
      { nodeKey: nodeKeyOf(p.primary), primary: true },
    ];
    for (const s of p.secondary)
      if (!wanted.some((w) => w.nodeKey === nodeKeyOf(s)))
        wanted.push({ nodeKey: nodeKeyOf(s), primary: false });
    const { changed } = await deps.map.setPlacements(faq.id, wanted, actor);
    report.placements.cards += 1;
    report.placements.changed += changed;
  }
  return report;
}

export type MapPruneReport = {
  /** 删掉的节点 key（种子里没有，或种类、父节点、所属阶段、属性和种子不一样，要重建）。 */
  deleted: string[];
  /** 从要删的节点上拿下来的挂载条数（卡的其他位置不动；种子里的卡随后按种子重挂）。 */
  detached: number;
};

/** 删的顺序：先叶子（岔子、格子），再步骤与对象，最后阶段（对象的所属阶段也引用阶段）。 */
const DELETE_ORDER: readonly FaqMapNode['kind'][] = [
  'deviation',
  'cell',
  'step',
  'object',
  'stage',
];

/**
 * 换一版树之前：数据库里种子没有的节点、或者要搬家的节点（种类、父节点、所属阶段、属性变了；upsertNode
 * 不搬节点）连同它们的子节点一起删掉；挂在这些节点上的卡先拿下来（只拿这些位置）。之后 seedFaqMap 按种子
 * 重建、重挂。按 key 比较，再跑一次什么都不删。结构只在「发布新版本」时冻结进快照，所以中途失败不影响
 * 学员端；再跑一次接着做完。BackOffice 还没有改结构的界面，节点都来自种子（以后有了要先排除员工建的）。
 */
export async function pruneFaqMap(
  deps: {
    map: Pick<
      FaqMapRepository,
      'nodes' | 'placements' | 'setPlacements' | 'deleteNode'
    >;
  },
  seed: MapSeed,
  actor: FaqActor,
): Promise<MapPruneReport> {
  const wanted = new Map(mapSeedNodes(seed).map((node) => [node.key, node]));
  const nodes = await deps.map.nodes();
  const keyOf = new Map(nodes.map((node) => [node.id, node.key]));
  const key = (id: string | null) =>
    id === null ? null : (keyOf.get(id) ?? null);
  const doomed = new Set(
    nodes
      .filter((node) => {
        const want = wanted.get(node.key);
        return (
          !want ||
          want.kind !== node.kind ||
          want.parentKey !== key(node.parentId) ||
          want.stageKey !== key(node.stageId) ||
          want.attribute !== node.attribute
        );
      })
      .map((node) => node.id),
  );
  // 子节点、属于要删阶段的对象也要删（否则删不掉父节点）
  for (let grew = true; grew;) {
    grew = false;
    for (const node of nodes)
      if (
        !doomed.has(node.id) &&
        ((node.parentId !== null && doomed.has(node.parentId)) ||
          (node.stageId !== null && doomed.has(node.stageId)))
      ) {
        doomed.add(node.id);
        grew = true;
      }
  }
  const report: MapPruneReport = { deleted: [], detached: 0 };
  if (doomed.size === 0) return report;
  const byFaq = new Map<string, { nodeId: string; primary: boolean }[]>();
  for (const p of await deps.map.placements())
    byFaq.set(p.faqId, [...(byFaq.get(p.faqId) ?? []), p]);
  for (const [faqId, places] of byFaq) {
    const keep = places.filter((p) => !doomed.has(p.nodeId));
    if (keep.length === places.length) continue;
    await deps.map.setPlacements(
      faqId,
      keep.map((p) => ({
        nodeKey: keyOf.get(p.nodeId) ?? '',
        primary: p.primary,
      })),
      actor,
    );
    report.detached += places.length - keep.length;
  }
  for (const kind of DELETE_ORDER)
    for (const node of nodes)
      if (node.kind === kind && doomed.has(node.id)) {
        await deps.map.deleteNode(node.id, actor);
        report.deleted.push(node.key);
      }
  return report;
}
