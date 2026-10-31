import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';
import { SocketEmitter } from '../src/infra/socket/socket-emitter.service.js';
import type { OpDto } from '../src/modules/board/dto/op.dto.js';
import { BoardService } from '../src/modules/board/services/board.service.js';
import { createBoard, createUser } from './helpers.js';

const RECT = { x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: '#000000', fillColor: 'transparent', strokeWidth: 1, strokeStyle: 'solid', opacity: 1 };
const add = (id: string = randomUUID()): OpDto => ({ opId: randomUUID(), type: 'add', element: { id, type: 'rect', data: RECT } }) as OpDto;
const update = (elementId: string, patch: Record<string, unknown>, baseVersion = 1): OpDto => ({ opId: randomUUID(), type: 'update', elementId, baseVersion, patch });

async function startNode() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await setupApp(app);
  await app.listen(0);
  return app;
}

describe('Board (e2e)', () => {
  let app: INestApplication;
  let node2: INestApplication; // node thứ hai: BoardLocks riêng, chỉ còn khóa DB giữ cho seq đúng
  let prisma: PrismaService;
  let boards: BoardService;

  beforeAll(async () => {
    [app, node2] = await Promise.all([startNode(), startNode()]);
    prisma = app.get(PrismaService);
    boards = app.get(BoardService);
  });

  afterAll(async () => {
    await Promise.all([app.close(), node2.close()]);
  });

  beforeEach(async () => {
    const redis = app.get<RedisClient>(REDIS);
    const keys = await redis.keys('rl:*');
    if (keys.length) await redis.del(keys);
  });

  describe('POST /api/v1/boards', () => {
    it('201: tạo bảng, người tạo là OWNER trong board_members; thiếu title -> "Untitled"', async () => {
      const user = await createUser(app);
      const res = await request(app.getHttpServer()).post('/api/v1/boards').set('Authorization', `Bearer ${user.token}`).send({}).expect(201);

      expect(res.body).toEqual({ id: expect.any(String), title: 'Untitled', createdAt: expect.any(String) });
      const board = await prisma.board.findUniqueOrThrow({ where: { id: res.body.id }, include: { members: true } });
      expect(board.ownerId).toBe(user.id);
      expect(board.lastSeq).toBe(0);
      expect(board.members).toEqual([expect.objectContaining({ userId: user.id, role: 'OWNER' })]);
    });

    it('title được trim; khóa lạ (ownerId) -> 400; không token -> 401', async () => {
      const user = await createUser(app);
      const post = () => request(app.getHttpServer()).post('/api/v1/boards');
      const res = await post().set('Authorization', `Bearer ${user.token}`).send({ title: '  Họp sprint  ' }).expect(201);
      expect(res.body.title).toBe('Họp sprint');

      await post().set('Authorization', `Bearer ${user.token}`).send({ title: 'x', ownerId: randomUUID() }).expect(400);
      await post().set('Authorization', `Bearer ${user.token}`).send({ title: '   ' }).expect(400);
      await post().send({}).expect(401);
    });
  });

  describe('BoardService.submitOps', () => {
    let userId: string;
    let boardId: string;
    beforeEach(async () => {
      userId = (await createUser(app)).id;
      boardId = (await createBoard(app, userId)).id;
    });

    it('lô 3 op, op giữa hỏng: 2 op còn lại lưu với seq liên tiếp, op hỏng không tốn seq', async () => {
      const r1 = randomUUID();
      const ops = [add(r1), update(randomUUID(), { x: 5 }), update(r1, { x: 200 })];
      const res = await boards.submitOps(boardId, userId, ops);

      expect(res.applied.map((a) => a.seq)).toEqual([1, 2]);
      expect(res.rejected).toEqual([{ opId: ops[1]!.opId, reason: 'not_found', current: undefined }]);
      // op thứ 3 thấy element do op 1 vừa thêm trong cùng lô
      const el = await prisma.element.findUniqueOrThrow({ where: { boardId_id: { boardId, id: r1 } } });
      expect(el).toMatchObject({ version: 2, updatedBy: userId, data: expect.objectContaining({ x: 200 }) });
      expect((await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).lastSeq).toBe(2);
    });

    it('cả lô bị từ chối -> last_seq không đổi', async () => {
      const res = await boards.submitOps(boardId, userId, [update(randomUUID(), { x: 1 })]);
      expect(res.applied).toEqual([]);
      expect((await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).lastSeq).toBe(0);
    });

    it('20 lô song song trên 2 node: seq 1..21 liên tục không trùng, version tăng đúng 20 lần', async () => {
      const r1 = randomUUID();
      await boards.submitOps(boardId, userId, [add(r1)]);
      const other = node2.get(BoardService);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 ? boards : other).submitOps(boardId, userId, [update(r1, { x: i })])),
      );

      const seqs = results.flatMap((r) => r.applied.map((a) => a.seq)).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
      const el = await prisma.element.findUniqueOrThrow({ where: { boardId_id: { boardId, id: r1 } } });
      expect(el.version).toBe(21);
      expect((await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).lastSeq).toBe(21);
    });

    it('z-index: mỗi hình thêm sau nằm trên; getState trả đúng thứ tự dưới -> trên', async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await boards.submitOps(boardId, userId, [add(ids[0]), add(ids[1])]);
      await boards.submitOps(boardId, userId, [add(ids[2])]);

      const state = await boards.getState(boardId);
      expect(state.elements.map((e) => e.id)).toEqual(ids);
      const z = state.elements.map((e) => e.zIndex);
      expect(z[0]! < z[1]! && z[1]! < z[2]!).toBe(true);
      expect(state.lastSeq).toBe(3);
    });

    it('clear: xóa mềm mọi hình KHÔNG khóa, một seq, trả đúng id; getState không còn chúng', async () => {
      const [a, b, locked] = [randomUUID(), randomUUID(), randomUUID()];
      await boards.submitOps(boardId, userId, [add(a), add(b), add(locked)]);
      await boards.submitOps(boardId, userId, [update(locked, { locked: true })]);

      const res = await boards.submitOps(boardId, userId, [{ opId: randomUUID(), type: 'clear' }]);
      expect(res.applied).toHaveLength(1);
      expect(res.applied[0]).toMatchObject({ seq: 5 });
      expect((res.applied[0] as { clearedIds: string[] }).clearedIds.sort()).toEqual([a, b].sort());
      expect((await boards.getState(boardId)).elements.map((e) => e.id)).toEqual([locked]);
    });

    it('bảng không tồn tại / đã xóa mềm -> BOARD_NOT_FOUND, không ghi gì', async () => {
      await expect(boards.submitOps(randomUUID(), userId, [add()])).rejects.toMatchObject({ code: 'BOARD_NOT_FOUND' });
      await prisma.board.update({ where: { id: boardId }, data: { deletedAt: new Date() } });
      await expect(boards.submitOps(boardId, userId, [add()])).rejects.toMatchObject({ code: 'BOARD_NOT_FOUND' });
      expect(await prisma.element.count({ where: { boardId } })).toBe(0);
    });
  });

  describe('nhật ký operations + chống gửi lại', () => {
    let userId: string;
    let boardId: string;
    beforeEach(async () => {
      userId = (await createUser(app)).id;
      boardId = (await createBoard(app, userId)).id;
    });

    it('mỗi op được nhận ghi một dòng operations với payload = kết quả cuối (element đã có zIndex, version)', async () => {
      const r1 = randomUUID();
      const ops = [add(r1), update(r1, { x: 7 })];
      await boards.submitOps(boardId, userId, ops);

      const rows = await prisma.operation.findMany({ where: { boardId }, orderBy: { seq: 'asc' } });
      expect(rows.map((r) => [r.seq, r.opId, r.type, r.elementId, r.actor])).toEqual([
        [1, ops[0]!.opId, 'add', r1, userId],
        [2, ops[1]!.opId, 'update', r1, userId],
      ]);
      expect(rows[1]!.payload).toEqual({ element: expect.objectContaining({ id: r1, version: 2, zIndex: expect.any(String), data: expect.objectContaining({ x: 7 }) }) });
    });

    it('gửi lại NGUYÊN lô: lần 2 toàn duplicates với seq cũ, không áp lại, last_seq không đổi, không phát OpsApplied', async () => {
      const r1 = randomUUID();
      const ops = [add(r1), update(r1, { x: 7 })];
      const first = await boards.submitOps(boardId, userId, ops);
      const emit = vi.spyOn(app.get(SocketEmitter), 'toBoard');

      const again = await boards.submitOps(boardId, userId, ops);
      expect(again).toEqual({ applied: [], rejected: [], duplicates: first.applied.map(({ opId, seq }) => ({ opId, seq })) });
      expect(emit).not.toHaveBeenCalled();
      emit.mockRestore();
      const el = await prisma.element.findUniqueOrThrow({ where: { boardId_id: { boardId, id: r1 } } });
      expect(el.version).toBe(2);
      expect((await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).lastSeq).toBe(2);
    });

    it('lô trộn op cũ + op mới: op cũ vào duplicates, op mới được áp với seq tiếp theo', async () => {
      const r1 = randomUUID();
      const old = add(r1);
      await boards.submitOps(boardId, userId, [old]);
      const fresh = update(r1, { x: 9 });
      const res = await boards.submitOps(boardId, userId, [old, fresh]);
      expect(res.duplicates).toEqual([{ opId: old.opId, seq: 1 }]);
      expect(res.applied.map((a) => [a.opId, a.seq])).toEqual([[fresh.opId, 2]]);
    });

    it('cùng một lô gửi đồng thời vào 2 node: đúng 1 lần được áp, lần kia là duplicates', async () => {
      const ops = [add()];
      const [x, y] = await Promise.all([boards.submitOps(boardId, userId, ops), node2.get(BoardService).submitOps(boardId, userId, ops)]);
      expect([x.applied.length, y.applied.length].sort((p, q) => p - q)).toEqual([0, 1]);
      expect([x.duplicates.length, y.duplicates.length].sort((p, q) => p - q)).toEqual([0, 1]);
      expect(await prisma.operation.count({ where: { boardId } })).toBe(1);
    });

    it('clear được ghi nhật ký: elementId null, payload.clearedIds', async () => {
      const a = randomUUID();
      await boards.submitOps(boardId, userId, [add(a)]);
      const clear: OpDto = { opId: randomUUID(), type: 'clear' };
      await boards.submitOps(boardId, userId, [clear]);
      const row = await prisma.operation.findFirstOrThrow({ where: { boardId, opId: clear.opId } });
      expect(row).toMatchObject({ seq: 2, type: 'clear', elementId: null, payload: { clearedIds: [a] } });
    });
  });

  describe('BoardService.getMissedOps', () => {
    let userId: string;
    let boardId: string;
    beforeEach(async () => {
      userId = (await createUser(app)).id;
      boardId = (await createBoard(app, userId)).id;
    });

    it('lỡ 3 op -> đúng 3 op theo thứ tự, CÙNG dạng với OpsApplied', async () => {
      const r1 = randomUUID();
      await boards.submitOps(boardId, userId, [add(r1)]); // seq 1: client đã có tới đây
      const emit = vi.spyOn(app.get(SocketEmitter), 'toBoard');
      await boards.submitOps(boardId, userId, [update(r1, { x: 1 }), update(r1, { x: 2 }, 2)]);
      await boards.submitOps(boardId, userId, [{ opId: randomUUID(), type: 'delete', elementId: r1 }]);
      const broadcast = emit.mock.calls.flatMap((c) => c[2] as unknown[]);
      emit.mockRestore();

      const missed = await boards.getMissedOps(boardId, 1);
      expect(missed!.map((o) => o.seq)).toEqual([2, 3, 4]);
      expect(JSON.parse(JSON.stringify(missed))).toEqual(JSON.parse(JSON.stringify(broadcast))); // phát lại y hệt lúc phát thật
    });

    it('đang mới nhất -> []; client "đi trước" server -> null (gửi cả bảng)', async () => {
      await boards.submitOps(boardId, userId, [add()]);
      await expect(boards.getMissedOps(boardId, 1)).resolves.toEqual([]);
      await expect(boards.getMissedOps(boardId, 99)).resolves.toBeNull();
    });

    it('op đầu đã bị dọn (thiếu khúc) -> null', async () => {
      await boards.submitOps(boardId, userId, [add(), add(), add()]);
      await prisma.operation.deleteMany({ where: { boardId, seq: 1 } });
      await expect(boards.getMissedOps(boardId, 0)).resolves.toBeNull();
      await expect(boards.getMissedOps(boardId, 1)).resolves.toHaveLength(2); // khúc sau seq 1 vẫn đủ
    });

    it('lỡ hơn 1000 op -> null; đúng 1000 -> vẫn phát lại', async () => {
      await prisma.operation.createMany({
        data: Array.from({ length: 1001 }, (_, i) => ({ boardId, seq: i + 1, opId: randomUUID(), type: 'clear', actor: userId, payload: { clearedIds: [] } })),
      });
      await prisma.board.update({ where: { id: boardId }, data: { lastSeq: 1001 } });
      await expect(boards.getMissedOps(boardId, 0)).resolves.toBeNull();
      await expect(boards.getMissedOps(boardId, 1)).resolves.toHaveLength(1000);
    });
  });

  describe('reorder + undo clear', () => {
    let userId: string;
    let boardId: string;
    const reorder = (elementId: string, position: 'front' | 'back' | 'forward' | 'backward'): OpDto => ({ opId: randomUUID(), type: 'reorder', elementId, position });
    const order = async () => (await boards.getState(boardId)).elements.map((e) => e.id);
    beforeEach(async () => {
      userId = (await createUser(app)).id;
      boardId = (await createBoard(app, userId)).id;
      await boards.submitOps(boardId, userId, ['A', 'B', 'C', 'D'].map((id) => add(id))); // dưới -> trên: A B C D
    });

    it('front / back / forward / backward đổi đúng thứ tự; payload OpsApplied mang zIndex đã tính', async () => {
      const res = await boards.submitOps(boardId, userId, [reorder('A', 'front')]);
      expect(res.applied[0]).toMatchObject({ type: 'reorder', element: { id: 'A', zIndex: expect.any(String), version: 2 } });
      expect(await order()).toEqual(['B', 'C', 'D', 'A']);
      await boards.submitOps(boardId, userId, [reorder('D', 'back')]);
      expect(await order()).toEqual(['D', 'B', 'C', 'A']);
      await boards.submitOps(boardId, userId, [reorder('B', 'forward')]);
      expect(await order()).toEqual(['D', 'C', 'B', 'A']);
      await boards.submitOps(boardId, userId, [reorder('B', 'backward'), reorder('B', 'backward')]); // 2 op cùng lô: op sau thấy op trước
      expect(await order()).toEqual(['B', 'D', 'C', 'A']);
    });

    it('forward nhảy qua element đã xóa (không tốn một lượt bấm vô hình); khóa mới không trùng khóa của element đã xóa', async () => {
      await boards.submitOps(boardId, userId, [{ opId: randomUUID(), type: 'delete', elementId: 'B' }]); // còn A C D
      await boards.submitOps(boardId, userId, [reorder('A', 'forward')]);
      expect(await order()).toEqual(['C', 'A', 'D']);
      await boards.submitOps(boardId, userId, [{ opId: randomUUID(), type: 'restore', elementId: 'B' }]);
      const z = (await boards.getState(boardId)).elements.map((e) => e.zIndex);
      expect(new Set(z).size).toBe(4);
    });

    it('đã trên cùng mà front -> no_change; element khóa / đã xóa -> locked / deleted; add sau reorder front trong cùng lô vẫn nằm trên', async () => {
      const res = await boards.submitOps(boardId, userId, [reorder('D', 'front'), reorder('A', 'back')]);
      expect(res.rejected.map((r) => r.reason)).toEqual(['no_change', 'no_change']);
      await boards.submitOps(boardId, userId, [update('C', { locked: true }), { opId: randomUUID(), type: 'delete', elementId: 'B' }]);
      const res2 = await boards.submitOps(boardId, userId, [reorder('C', 'front'), reorder('B', 'front')]);
      expect(res2.rejected.map((r) => r.reason)).toEqual(['locked', 'deleted']);

      await boards.submitOps(boardId, userId, [reorder('A', 'front'), add('E')]);
      expect((await order()).slice(-2)).toEqual(['A', 'E']);
    });

    it('undo clear (restore { clearSeq }): bật lại đúng những hình bị clear, gửi kèm đủ element; hình vẽ sau clear không ảnh hưởng; undo lần 2 -> not_deleted', async () => {
      const cleared = await boards.submitOps(boardId, userId, [{ opId: randomUUID(), type: 'clear' }]);
      const clearSeq = cleared.applied[0]!.seq;
      await boards.submitOps(boardId, userId, [add('after')]);

      const res = await boards.submitOps(boardId, userId, [{ opId: randomUUID(), type: 'restore', clearSeq }]);
      expect(res.applied).toHaveLength(1);
      const applied = res.applied[0] as { type: string; clearSeq: number; elements: { id: string; version: number }[] };
      expect(applied).toMatchObject({ type: 'restore', clearSeq });
      expect(applied.elements.map((e) => e.id).sort()).toEqual(['A', 'B', 'C', 'D']);
      expect(applied.elements.every((e) => e.version === 3)).toBe(true); // add 1, clear 2, restore 3
      expect(await order()).toEqual(['A', 'B', 'C', 'D', 'after']);

      // phát lại MissedOps đúng y OpsApplied
      const missed = await boards.getMissedOps(boardId, clearSeq + 1);
      expect(missed).toEqual([expect.objectContaining({ type: 'restore', clearSeq, elements: expect.any(Array) })]);

      const again = await boards.submitOps(boardId, userId, [{ opId: randomUUID(), type: 'restore', clearSeq }]);
      expect(again.rejected).toEqual([expect.objectContaining({ reason: 'not_deleted' })]);
    });

    it('clearSeq không phải op clear / không tồn tại -> not_found', async () => {
      const res = await boards.submitOps(boardId, userId, [
        { opId: randomUUID(), type: 'restore', clearSeq: 1 }, // seq 1 là add
        { opId: randomUUID(), type: 'restore', clearSeq: 999 },
      ]);
      expect(res.rejected.map((r) => r.reason)).toEqual(['not_found', 'not_found']);
    });
  });
});
