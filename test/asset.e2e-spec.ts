import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';
import type { OpDto } from '../src/modules/board/dto/op.dto.js';
import { BoardService } from '../src/modules/board/services/board.service.js';
import { createBoard, createUser } from './helpers.js';

// PNG 1x1 thật (magic byte 89 50 4E 47 ...)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const imageOp = (assetId: string): OpDto => ({
  opId: randomUUID(),
  type: 'add',
  element: { id: randomUUID(), type: 'image', data: { x: 0, y: 0, width: 100, height: 100, angle: 0, assetId } },
});

describe('Upload ảnh (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const upload = (token: string, boardId: string, data: Buffer, filename: string, contentType: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/boards/${boardId}/assets`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', data, { filename, contentType });
  const fetchAsset = (token: string, assetId: string) =>
    request(app.getHttpServer()).get(`/api/v1/assets/${assetId}`).set('Authorization', `Bearer ${token}`).buffer(true);
  const codeOf = (res: { body: { errors: { code: string }[] } }) => res.body.errors[0]?.code;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    const redis = app.get<RedisClient>(REDIS);
    const keys = await redis.keys('rl:*');
    if (keys.length) await redis.del(keys);
  });

  afterAll(async () => {
    await app.close();
  });

  it('PNG thật -> 201; file nằm ở UPLOAD_DIR với tên do server đặt; GET trả lại đúng byte + header', async () => {
    const owner = await createUser(app);
    const board = await createBoard(app, owner.id);
    const res = await upload(owner.token, board.id, PNG, '../../evil name.png', 'image/png').expect(201);
    expect(res.body).toEqual({ assetId: expect.any(String), url: `/api/v1/assets/${res.body.assetId}`, mimeType: 'image/png', sizeBytes: PNG.length });

    const row = await prisma.asset.findUniqueOrThrow({ where: { id: res.body.assetId } });
    expect(row).toMatchObject({ boardId: board.id, storageKey: `${board.id}/${res.body.assetId}.png`, uploadedBy: owner.id, checksum: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await readFile(path.join(process.env['UPLOAD_DIR']!, row.storageKey))).toEqual(PNG); // originalname "../../evil" không được dùng

    const got = await fetchAsset(owner.token, res.body.assetId).expect(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(got.body as Buffer)).toEqual(PNG);
  });

  it.each([
    ['file .exe đổi tên thành .png + Content-Type image/png', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]), 'x.png', 'image/png'],
    ['SVG (có thể chứa script)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml'],
    ['PDF', Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'), 'x.png', 'image/png'],
  ])('%s -> 400 INVALID_IMAGE, không ghi gì', async (_, data, filename, type) => {
    const owner = await createUser(app);
    const board = await createBoard(app, owner.id);
    expect(codeOf(await upload(owner.token, board.id, data, filename, type).expect(400))).toBe('INVALID_IMAGE');
    expect(await prisma.asset.count({ where: { boardId: board.id } })).toBe(0);
  });

  it('11 MB -> 413; không gửi file -> 400', async () => {
    const owner = await createUser(app);
    const board = await createBoard(app, owner.id);
    const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    await upload(owner.token, board.id, big, 'big.png', 'image/png').expect(413);
    await request(app.getHttpServer()).post(`/api/v1/boards/${board.id}/assets`).set('Authorization', `Bearer ${owner.token}`).expect(400);
  });

  it('VIEWER upload -> 403; người lạ upload -> 404; người lạ xem ảnh -> 404 (giống id không tồn tại); VIEWER xem được', async () => {
    const [owner, viewer, stranger] = [await createUser(app), await createUser(app), await createUser(app)];
    const board = await createBoard(app, owner.id);
    await prisma.boardMember.create({ data: { boardId: board.id, userId: viewer.id, role: 'VIEWER' } });
    expect(codeOf(await upload(viewer.token, board.id, PNG, 'a.png', 'image/png').expect(403))).toBe('BOARD_FORBIDDEN');
    expect(codeOf(await upload(stranger.token, board.id, PNG, 'a.png', 'image/png').expect(404))).toBe('BOARD_NOT_FOUND');

    const { body } = await upload(owner.token, board.id, PNG, 'a.png', 'image/png').expect(201);
    expect(codeOf(await fetchAsset(stranger.token, body.assetId).expect(404))).toBe('ASSET_NOT_FOUND');
    expect(codeOf(await fetchAsset(owner.token, randomUUID()).expect(404))).toBe('ASSET_NOT_FOUND');
    await fetchAsset(owner.token, 'not-a-uuid').expect(400);
    await fetchAsset(viewer.token, body.assetId).expect(200);
  });

  it('op add image: ảnh của bảng mình -> lưu; ảnh của bảng khác / id bịa -> asset_not_found; update đổi assetId cũng bị kiểm', async () => {
    const owner = await createUser(app);
    const [board, other] = [await createBoard(app, owner.id), await createBoard(app, owner.id)];
    const mine = (await upload(owner.token, board.id, PNG, 'a.png', 'image/png').expect(201)).body.assetId as string;
    const theirs = (await upload(owner.token, other.id, PNG, 'b.png', 'image/png').expect(201)).body.assetId as string;
    const boards = app.get(BoardService);

    const ok = imageOp(mine);
    const res = await boards.submitOps(board.id, owner.id, [ok, imageOp(theirs), imageOp(randomUUID())]);
    expect(res.applied.map((a) => a.opId)).toEqual([ok.opId]);
    expect(res.rejected.map((r) => r.reason)).toEqual(['asset_not_found', 'asset_not_found']);

    const elementId = (ok as Extract<OpDto, { type: 'add' }>).element.id;
    const swap = await boards.submitOps(board.id, owner.id, [{ opId: randomUUID(), type: 'update', elementId, baseVersion: 1, patch: { assetId: theirs } }]);
    expect(swap.rejected.map((r) => r.reason)).toEqual(['asset_not_found']);
    const bad = await boards.submitOps(board.id, owner.id, [{ opId: randomUUID(), type: 'update', elementId, baseVersion: 1, patch: { assetId: 'nope' } }]);
    expect(bad.rejected.map((r) => r.reason)).toEqual(['invalid_patch']); // không phải UUID -> domain chặn, không chạm query
  });
});
