import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/common/app-setup';
import { FilesService } from '../src/files/files.service';
import { ReleasePackagesService } from '../src/releases/release-packages.service';
import { ReleasesController } from '../src/releases/releases.controller';
import { ReleasesService } from '../src/releases/releases.service';
import { TeachingCardsService } from '../src/releases/teaching-cards.service';

describe('POST /api/courses/:id/release', () => {
  let app: INestApplication<App>;
  const publish = jest.fn().mockResolvedValue({ id: 'r1' });
  const path = '/api/courses/c1/release';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReleasesController],
      providers: [
        { provide: ReleasesService, useValue: { publish } },
        { provide: TeachingCardsService, useValue: {} },
        { provide: ReleasePackagesService, useValue: {} },
        { provide: FilesService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });
  beforeEach(() => publish.mockClear());
  afterAll(() => app?.close());

  it('accepts revision notes alone', async () => {
    await request(app.getHttpServer())
      .post(path)
      .send({ revisionNotes: 'V1' })
      .expect(201);
    expect(publish).toHaveBeenCalledWith('c1', { revisionNotes: 'V1' });
  });

  it.each([{}, { revisionNotes: '   ' }])(
    'requires notes before publishing',
    async (body) => {
      await request(app.getHttpServer()).post(path).send(body).expect(400);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('passes an explicit teaching package through to publishing', async () => {
    const body = {
      revisionNotes: 'V1',
      teachingPackage: { cards: [], glossary: [] },
    };
    await request(app.getHttpServer()).post(path).send(body).expect(201);
    expect(publish).toHaveBeenCalledWith('c1', body);
  });

  it.each([null, []])(
    'rejects teaching packages that are not objects',
    async (teachingPackage) => {
      await request(app.getHttpServer())
        .post(path)
        .send({ revisionNotes: 'V1', teachingPackage })
        .expect(400);
      expect(publish).not.toHaveBeenCalled();
    },
  );
});
