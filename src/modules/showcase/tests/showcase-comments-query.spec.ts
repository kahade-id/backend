/**
 * Non-regresi Bug #3 (komentar showcase 422) — commit `8be3fff`.
 *
 * Akar masalah: `GET /v1/showcase/:showcaseId/comments` memakai
 * `@Query() PaginationDto` + `@Query('sort')` / `@Query('cursor')` terpisah,
 * sedangkan global ValidationPipe memakai `whitelist + forbidNonWhitelisted`
 * → query yang sah dari frontend (`?sort=newest`, `?cursor=…`) ditolak
 * 422 "property sort should not exist". Perbaikannya: `ListShowcaseCommentsDto`
 * (PaginationDto + `sort` + `cursor`) dan `CursorPaginationDto` untuk endpoint
 * keyset lain (listSaved, likers, savers).
 *
 * Test ini menjalankan HTTP nyata lewat controller + DTO asli dengan opsi
 * ValidationPipe yang SAMA seperti main.ts (422 + atribusi field), sehingga
 * regresi apa pun (mis. field DTO dihapus/rename) langsung terlihat.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Reflector } from '@nestjs/core';

import { ShowcaseController } from '../showcase.controller';
import { ShowcaseService } from '../showcase.service';
import { PhoneVerifiedGuard } from '../../../common/guards/phone-verified.guard';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { validationExceptionFactory } from '../../../common/pipes/validation-exception.factory';
import { ResponseTransformInterceptor } from '../../../common/interceptors/response-transform.interceptor';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';
import { ListShowcaseCommentsDto } from '../dto/showcase-comment.dto';
import { CursorPaginationDto } from '../../../common/dto/pagination.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

const SHOWCASE_ID = 'clxshowcase00000000000001'; // 25 char: c + 24 [a-z0-9]
const CURSOR = Buffer.from(JSON.stringify({ t: 1759800000000, i: 'clxcomment01' }), 'utf8').toString('base64url');

describe('Bug #3 — GET /showcase/:id/comments tidak lagi 422 untuk sort/cursor', () => {
  let app: INestApplication;
  const listComments = jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false });
  const listSavedShowcases = jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ShowcaseController],
      providers: [
        { provide: ShowcaseService, useValue: { listComments, listSavedShowcases } },
      ],
    })
      .overrideGuard(PhoneVerifiedGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    // Opsi identik dengan src/main.ts (422 + forbidNonWhitelisted).
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        errorHttpStatusCode: 422,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    app.useGlobalInterceptors(new ResponseTransformInterceptor(app.get(Reflector)));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    listComments.mockClear();
    listSavedShowcases.mockClear();
  });

  it('?sort=newest&page=1&limit=5 → 200 (bukan 422) dan diteruskan ke service', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/showcase/${SHOWCASE_ID}/comments?sort=newest&page=1&limit=5`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(listComments).toHaveBeenCalledWith(SHOWCASE_ID, undefined, 1, 5, 'newest', undefined);
  });

  it('?sort=oldest&cursor=… → 200 (keyset) dan cursor diteruskan utuh', async () => {
    await request(app.getHttpServer())
      .get(`/v1/showcase/${SHOWCASE_ID}/comments?sort=oldest&cursor=${encodeURIComponent(CURSOR)}`)
      .expect(200);

    expect(listComments).toHaveBeenCalledWith(SHOWCASE_ID, undefined, 1, 20, 'oldest', CURSOR);
  });

  it('nilai sort di luar enum tetap ditolak 422 (validasi tidak dimatikan)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/showcase/${SHOWCASE_ID}/comments?sort=terbaru`)
      .expect(422);
    expect(JSON.stringify(res.body)).toContain('sort');
    expect(listComments).not.toHaveBeenCalled();
  });

  it('query tak dikenal tetap ditolak 422 (forbidNonWhitelisted aktif)', async () => {
    await request(app.getHttpServer())
      .get(`/v1/showcase/${SHOWCASE_ID}/comments?limit=5&tidakAda=1`)
      .expect(422);
    expect(listComments).not.toHaveBeenCalled();
  });

  it('limit di luar batas (1..100) → 422', async () => {
    await request(app.getHttpServer())
      .get(`/v1/showcase/${SHOWCASE_ID}/comments?limit=101`)
      .expect(422);
  });

  it('endpoint CursorPaginationDto lain (saved) tetap menerima cursor', async () => {
    await request(app.getHttpServer())
      .get(`/v1/showcase/saved?cursor=${encodeURIComponent(CURSOR)}&limit=10`)
      .expect(200);
    // Anonim (tanpa CurrentUser) → null; yang penting DTO-nya lolos validasi
    // dan cursor diteruskan utuh (bukan 422 "property cursor should not exist").
    expect(listSavedShowcases).toHaveBeenCalledWith(null, 1, 10, CURSOR);
  });

  it('DTO: ListShowcaseCommentsDto & CursorPaginationDto menerima sort/cursor tanpa error', async () => {
    const comments = plainToInstance(ListShowcaseCommentsDto, { page: 2, limit: 50, sort: 'oldest', cursor: CURSOR });
    expect(await validate(comments, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);

    const cursorOnly = plainToInstance(CursorPaginationDto, { cursor: CURSOR });
    expect(await validate(cursorOnly, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });
});
