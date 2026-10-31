import { HelpdeskError } from '../portalHelpdeskClient';
import type { FaqActor } from './faqContracts';
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
 * 按 key 幂等：再跑一次只改有变化的。岔子与格子由挂载带出来（岔子的 key 与文字写在挂载里；格子 =
 * rules.<对象>.<属性>）。不建发布版本：结构随下一次「发布新版本」冻结进快照。
 */

type Labels = { labelEn: string; labelZh: string };

export type MapPlace =
  | { node: 'step'; step: string }
  | {
      node: 'deviation';
      step: string;
      deviation: { key: string; en: string; zh: string };
    }
  | { node: 'cell'; object: string; attribute: Attribute };

export type MapSeed = {
  stages: (Labels & { key: string; steps: (Labels & { key: string })[] })[];
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

function place(raw: unknown, what: string): MapPlace {
  const body = record(raw, what);
  if (body.node === 'step')
    return { node: 'step', step: text(body.step, `${what}.step`) };
  if (body.node === 'deviation') {
    const deviation = record(body.deviation, `${what}.deviation`);
    return {
      node: 'deviation',
      step: text(body.step, `${what}.step`),
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
    return {
      node: 'cell',
      object: text(body.object, `${what}.object`),
      attribute: attribute as Attribute,
    };
  }
  throw invalid(`${what}: node must be step, deviation or cell`);
}

/**
 * 读结构文件（宽松读：不认识的字段忽略）。skeleton：{ stages: [{ key, labelEn, label | labelZh,
 * steps: [...] }], objects: [{ key, labelEn, label | labelZh, stage }], attributes: [{ key, labelEn,
 * label | labelZh }] }；对象的 stage 可以写阶段 key，也可以写 S1…S9（按 stages 的顺序）。
 * 每个挂载文件：{ key（卡的 key）, primary, secondary? }。
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
        return {
          key: text(step.key, `stages[${i}].steps[${j}].key`),
          ...labels(step, `stages[${i}].steps[${j}]`),
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
  const placements = placementFiles.map((raw, i) => {
    const file = record(raw, `placements[${i}]`);
    return {
      faqKey: text(file.key, `placements[${i}].key`),
      primary: place(file.primary, `placements[${i}].primary`),
      secondary: list(file.secondary ?? [], `placements[${i}].secondary`).map(
        (s, j) => place(s, `placements[${i}].secondary[${j}]`),
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

/** 种子里全部节点（父节点在前），岔子与格子从挂载里收集。 */
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
