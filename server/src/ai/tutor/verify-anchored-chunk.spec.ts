import { buildAnchoredChunks } from './anchored-chunks';
import { verifyAnchoredChunk } from './verify-anchored-chunk';

const input = {
  courseId: 'course',
  releaseId: 'release',
  snapshot: {
    pages: [{ id: 'page', title: 'Title', contentMd: '# Heading\n正文' }],
  },
};
const verify = (candidate: unknown) =>
  verifyAnchoredChunk({ ...input, candidate });

describe('verifyAnchoredChunk', () => {
  it('接受与可信快照一致的块', () => {
    const chunk = buildAnchoredChunks(input)[0];
    const result = verify(chunk);
    expect(result).toEqual({ valid: true, chunk });
    if (result.valid) {
      chunk.content = 'changed later';
      expect(result.chunk.content).not.toBe(chunk.content);
    }
  });
  it('拒绝正文、路径、元数据和额外字段的篡改', () => {
    const chunk = buildAnchoredChunks(input)[0];
    for (const candidate of [
      { ...chunk, content: '其他内容' },
      { ...chunk, anchor: { ...chunk.anchor, headingPath: ['伪造'] } },
      { ...chunk, tokenCount: 0 },
      { ...chunk, extra: true },
    ])
      expect(verify(candidate)).toEqual({
        valid: false,
        reason: 'CHUNK_MISMATCH',
      });
  });
  it('拒绝其他版本、未知 ID、无效值与非 JSON 数据', () => {
    const chunk = buildAnchoredChunks(input)[0];
    expect(
      verifyAnchoredChunk({ ...input, releaseId: 'other', candidate: chunk }),
    ).toEqual({ valid: false, reason: 'CHUNK_NOT_FOUND' });
    expect(verify({ ...chunk, id: 'missing' })).toEqual({
      valid: false,
      reason: 'CHUNK_NOT_FOUND',
    });
    expect(verify(null)).toEqual({ valid: false, reason: 'INVALID_CANDIDATE' });
    expect(verify({ ...chunk, extra: undefined })).toEqual({
      valid: false,
      reason: 'INVALID_CANDIDATE',
    });
  });
  it('受控拒绝 getter、代理、符号和数组附加属性', () => {
    const chunk = buildAnchoredChunks(input)[0];
    const getter = Object.defineProperty({ ...chunk }, 'id', {
      get: () => {
        throw new Error('bad');
      },
      enumerable: true,
    });
    const proxy = new Proxy(chunk, {
      ownKeys: () => {
        throw new Error('bad');
      },
    });
    const transparentProxy = new Proxy(chunk, {});
    const symbol = { ...chunk, [Symbol('extra')]: true };
    const headingPath = Object.assign([...chunk.anchor.headingPath], {
      extra: undefined,
    });
    const arrayExtra = { ...chunk, anchor: { ...chunk.anchor, headingPath } };
    for (const candidate of [
      getter,
      proxy,
      transparentProxy,
      symbol,
      arrayExtra,
    ]) {
      expect(verify(candidate)).toEqual({
        valid: false,
        reason: 'INVALID_CANDIDATE',
      });
    }
  });
});
