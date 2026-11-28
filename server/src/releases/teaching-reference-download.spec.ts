import type { Response } from 'express';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { FilesService } from '../files/files.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ReleasePackagesService } from './release-packages.service';
import { ReleasesController } from './releases.controller';
import type { ReleasesService } from './releases.service';
import { TeachingCardsService } from './teaching-cards.service';
import {
  readReferenceDocument,
  type ReferenceKind,
} from './teaching-reference-document';

function savedCard(kind: ReferenceKind, code: string, value: string) {
  return {
    id: code,
    draft: {
      type: 'ref_obj',
      approvedPayload: {
        code,
        refObjects: [{ id: code, kind, label: code, value, requires: [] }],
      },
      bilingual: {
        conceptLabel: { en: code, zh: '' },
        summary: { en: 'Teaching reference', zh: '' },
      },
    },
  };
}

it('exports the selected workspace references and keeps image bytes on re-import', async () => {
  const asset = '94b987df-f70c-4595-aa41-c47b17d3f395.png';
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const getImage = jest.fn().mockResolvedValue({ bytes });
  const files = {
    getImage,
    fitsReferenceDocument: jest.fn().mockResolvedValue(true),
  } as unknown as FilesService;
  const formulas = Array.from({ length: 500 }, (_, i) =>
    savedCard('latex', 'f' + i, 'x+y'),
  );
  const entries = [...formulas, savedCard('image', 'i01', asset)];
  const findMany = jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
    entries.filter(({ id }) => where.id.in.includes(id)),
  );
  const tx = {
    course: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ title: 'Course' }),
    },
    tutorTeachingCard: { findMany },
  };
  const service = new TeachingCardsService(
    {
      $transaction: (run: (client: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaService,
    files,
  );
  const controller = new ReleasesController(
    {} as ReleasesService,
    service,
    {} as ReleasePackagesService,
    files,
  );

  const download = async (
    kind: ReferenceKind,
    ids: string[],
    label: string,
  ) => {
    const setHeader = jest.fn();
    const send = jest.fn<void, [Buffer]>();
    const type = jest.fn().mockReturnValue({ send });
    await controller.downloadCurrentTeaching(
      'course',
      kind,
      'zh-CN',
      ids,
      undefined,
      { setHeader, type } as unknown as Response,
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      "attachment; filename*=UTF-8''" +
        encodeURIComponent('Course_' + label + '.docx'),
    );
    expect(type).toHaveBeenCalledWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    return readReferenceDocument(await JSZip.loadAsync(send.mock.calls[0][0]));
  };

  const formulasOut = await download(
    'latex',
    formulas.map(({ id }) => id),
    '公式引用',
  );
  expect(formulasOut).toHaveLength(500);
  expect(formulasOut?.at(-1)).toMatchObject({ code: 'f499', value: 'x+y' });
  expect(getImage).not.toHaveBeenCalled();
  const imagesOut = await download('image', ['i01'], '图片引用');
  expect(imagesOut?.map(({ code, bytes }) => [code, bytes])).toEqual([
    ['i01', bytes],
  ]);
  expect(getImage).toHaveBeenCalledTimes(1);
  expect(getImage).toHaveBeenCalledWith('course', asset);
  await expect(
    service.download(
      'course',
      'image',
      Array.from({ length: 301 }, (_, i) => 'i' + i),
      false,
    ),
  ).rejects.toMatchObject({ status: 413 });
  expect(findMany).toHaveBeenCalledTimes(2);
});
