import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { KnowledgeClient } from '../ks/contract/knowledge-client';
import { LearnerImageController } from './learner-image.controller';

describe('LearnerImageController', () => {
  const asset = '12345678-1234-1234-1234-123456789abc.png';
  function setup() {
    const knowledge = {
      getCourseByExternalId: jest.fn().mockResolvedValue({
        id: 'c1',
        aiTutorOnline: true,
        currentReleaseId: 'r1',
      }),
      getRelease: jest.fn().mockResolvedValue({
        id: 'r1',
        courseId: 'c1',
        pages: [{ contentMd: `![Figure](/api/files/images/c1/${asset})` }],
      }),
    };
    const files = {
      getImage: jest.fn().mockResolvedValue({
        bytes: Buffer.from('png'),
        contentType: 'image/png',
      }),
    };
    const res = { setHeader: jest.fn(), send: jest.fn() };
    const controller = new LearnerImageController(
      knowledge as unknown as KnowledgeClient,
      files,
    );
    return {
      knowledge,
      files,
      res,
      get: (id = asset) =>
        controller.getImage('slug', id, res as unknown as Response),
    };
  }

  it('只返回上线快照引用的本课程图片', async () => {
    const { get, files, res } = setup();
    await get();
    expect(files.getImage).toHaveBeenCalledWith('c1', asset);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png'));
  });

  it.each(['../secret.png', 'invalid.png'])('拒绝非法路径 %s', async (id) => {
    const { get, files } = setup();
    await expect(get(id)).rejects.toBeInstanceOf(NotFoundException);
    expect(files.getImage).not.toHaveBeenCalled();
  });

  it.each(['offline', 'wrong-course', 'unpublished-image', 'missing-file'])(
    '拒绝 %s',
    async (scenario) => {
      const { get, knowledge, files } = setup();
      if (scenario === 'offline')
        knowledge.getCourseByExternalId.mockResolvedValue(null);
      if (scenario === 'wrong-course')
        knowledge.getRelease.mockResolvedValue({
          id: 'r1',
          courseId: 'c2',
          pages: [],
        });
      if (scenario === 'unpublished-image')
        knowledge.getRelease.mockResolvedValue({
          id: 'r1',
          courseId: 'c1',
          pages: [],
        });
      if (scenario === 'missing-file') files.getImage.mockResolvedValue(null);
      await expect(get()).rejects.toBeInstanceOf(NotFoundException);
    },
  );
});
