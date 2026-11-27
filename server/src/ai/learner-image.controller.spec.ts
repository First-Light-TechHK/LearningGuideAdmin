import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { KnowledgeClient } from '../ks/contract/knowledge-client';
import { LearnerImageController } from './learner-image.controller';

describe('LearnerImageController', () => {
  const asset = '12345678-1234-1234-1234-123456789abc.png';
  const teachingImageRelease = {
    id: 'r1',
    courseId: 'c1',
    pages: [],
    teachingPackage: {
      cards: [
        {
          approvedPayload: {
            refObjects: [
              {
                id: 'exhibit-112',
                label: 'Exhibit 1.12',
                requires: [],
                kind: 'image',
                value: asset,
              },
            ],
          },
        },
      ],
    },
  };

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

  it('返回上线页面正文引用的本课程图片', async () => {
    const { get, files, res } = setup();
    await get();
    expect(files.getImage).toHaveBeenCalledWith('c1', asset);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png'));
  });

  it('返回只在上线教学包中登记的图片', async () => {
    const { get, knowledge, files, res } = setup();
    knowledge.getRelease.mockResolvedValue(teachingImageRelease);

    await get();

    expect(knowledge.getRelease).toHaveBeenCalledWith('r1');
    expect(files.getImage).toHaveBeenCalledWith('c1', asset);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('png'));
  });

  it('只读取上线版本，即使测试版登记了图片', async () => {
    const { get, knowledge, files } = setup();
    knowledge.getCourseByExternalId.mockResolvedValue({
      id: 'c1',
      aiTutorOnline: true,
      currentReleaseId: 'r1',
      aiTestReleaseId: 'r2',
    });
    knowledge.getRelease.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'r2'
          ? { ...teachingImageRelease, id: 'r2' }
          : { id: 'r1', courseId: 'c1', pages: [] },
      ),
    );

    await expect(get()).rejects.toBeInstanceOf(NotFoundException);
    expect(knowledge.getRelease).toHaveBeenCalledTimes(1);
    expect(knowledge.getRelease).toHaveBeenCalledWith('r1');
    expect(files.getImage).not.toHaveBeenCalled();
  });

  it('损坏的教学包不会放行图片', async () => {
    const { get, knowledge, files } = setup();
    knowledge.getRelease.mockResolvedValue({
      ...teachingImageRelease,
      teachingPackage: {
        cards: [
          {
            approvedPayload: { refObjects: [{ kind: 'image', value: asset }] },
          },
        ],
      },
    });

    await expect(get()).rejects.toBeInstanceOf(NotFoundException);
    expect(files.getImage).not.toHaveBeenCalled();
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
          ...teachingImageRelease,
          courseId: 'c2',
        });
      if (scenario === 'unpublished-image')
        knowledge.getRelease.mockResolvedValue({
          id: 'r1',
          courseId: 'c1',
          pages: [],
        });
      if (scenario === 'missing-file') {
        knowledge.getRelease.mockResolvedValue(teachingImageRelease);
        files.getImage.mockResolvedValue(null);
      }
      await expect(get()).rejects.toBeInstanceOf(NotFoundException);
      if (scenario === 'wrong-course')
        expect(files.getImage).not.toHaveBeenCalled();
    },
  );
});
