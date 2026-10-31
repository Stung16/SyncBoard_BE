import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';
import type { OpDto } from '../src/modules/board/dto/op.dto.js';
import { SnapshotScheduler } from '../src/modules/board/jobs/snapshot.scheduler.js';
import { BoardService } from '../src/modules/board/services/board.service.js';
import { SnapshotService } from '../src/modules/board/services/snapshot.service.js';
import { connect, createBoard, createUser, joinPayload, nextEvent } from './helpers.js';

const RECT = { x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: '#000000', fillColor: 'transparent', strokeWidth: 1, strokeStyle: 'solid', opacity: 1 };
const add = (id: string): OpDto => ({ opId: randomUUID(), type: 'add', element: { id, type: 'rect', data: RECT } }) as OpDto;
const del = (elementId: string): OpDto => ({ opId: randomUUID(), type: 'delete', elementId });

describe('Snapshot: chụp định kỳ, khôi phục, dọn op (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let boards: BoardService;
  let snapshots: SnapshotService;
  let scheduler: SnapshotScheduler;
  const clients: Socket[] = [];
  const api = (token: string) => {
    const http = request(app.getHttpServer());
    return {
      get: (path: string) => http.get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`),
      post: (path: string) => http.post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send({}),
    };
  };
  const codeOf = (res: { body: { errors: { code: string }[] } }) => res.body.errors[0]?.code;
  const snapshotsOf = (boardId: string) => prisma.snapshot.findMany({ where: { boardId }, orderBy: { seq: 'asc' } });
  const visibleIds = async (boardId: string) => (await boards.getState(boardId)).elements.map((e) => e.id).sort();

  // Bảng của owner (EDITOR thêm sẵn), vẽ e1, e2 -> seq 2
  const boardWithTwo = async () => {
    const [owner, editor] = [await createUser(app), await createUser(app)];
    const board = await createBoard(app, owner.id, [editor.id]);
    await boards.submitOps(board.id, owner.id, [add('e1'), add('e2')]);
    return { owner, editor, boardId: board.id };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    boards = app.get(BoardService);
    snapshots = app.get(SnapshotService);
    scheduler = app.get(SnapshotScheduler);
  });

  beforeEach(async () => {
    const redis = app.get<RedisClient>(REDIS);
    const keys = await redis.keys('rl:*');
    if (keys.length) await redis.del(keys);
  });

  afterEach(() => {
    clients.splice(0).forEach((c) => c.disconnect());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('job chụp định kỳ', () => {
    it('bảng có op mới -> đúng 1 bản (seq hiện tại, formatVersion 1); chạy lại không đổi gì -> không chụp thêm; bảng chưa vẽ -> không chụp', async () => {
      const { boardId } = await boardWithTwo();
      const empty = await createBoard(app, (await createUser(app)).id);

      await scheduler.captureChanged();
      const [snap] = await snapshotsOf(boardId);
      expect(await snapshotsOf(boardId)).toHaveLength(1);
      expect(snap).toMatchObject({ seq: 2, label: null, data: { formatVersion: 1, elements: [expect.objectContaining({ id: 'e1' }), expect.objectContaining({ id: 'e2' })] } });

      await scheduler.captureChanged();
      expect(await snapshotsOf(boardId)).toHaveLength(1);
      expect(await snapshotsOf(empty.id)).toHaveLength(0);
    });

    it('hai lần chạy chồng nhau -> lần sau bỏ lượt (null); chụp trùng cùng seq (2 node) -> chỉ 1 dòng', async () => {
      const { boardId } = await boardWithTwo();
      const results = await Promise.all([scheduler.captureChanged(), scheduler.captureChanged()]);
      expect(results).toContain(null);
      expect(await snapshots.capture(boardId)).toBe(0); // seq 2 đã có -> ON CONFLICT bỏ qua
      expect(await snapshotsOf(boardId)).toHaveLength(1);
    });
  });

  describe('xem lịch sử (REST)', () => {
    it('thành viên xem danh sách (mới nhất trước, không kèm data) + xem một bản; người lạ 404; id của bảng khác 404', async () => {
      const { owner, editor, boardId } = await boardWithTwo();
      await snapshots.capture(boardId);
      await boards.submitOps(boardId, owner.id, [add('e3')]);
      await snapshots.capture(boardId);

      const { body: list } = await api(editor.token).get(`/boards/${boardId}/snapshots`).expect(200);
      expect(list).toEqual([
        { id: expect.any(String), seq: 3, label: null, createdAt: expect.any(String) },
        { id: expect.any(String), seq: 2, label: null, createdAt: expect.any(String) },
      ]);
      const { body: one } = await api(editor.token).get(`/boards/${boardId}/snapshots/${list[1].id}`).expect(200);
      expect(one.data.elements.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2']);

      const stranger = await createUser(app);
      expect(codeOf(await api(stranger.token).get(`/boards/${boardId}/snapshots`).expect(404))).toBe('BOARD_NOT_FOUND');
      const other = await boardWithTwo();
      expect(codeOf(await api(other.owner.token).get(`/boards/${other.boardId}/snapshots/${list[0].id}`).expect(404))).toBe('SNAPSHOT_NOT_FOUND');
    });
  });

  describe('khôi phục', () => {
    it('element thừa bị ẩn, element thiếu quay lại, version tăng; phòng nhận BoardReset; có bản before-restore; nhật ký có op restore_snapshot', async () => {
      const { owner, editor, boardId } = await boardWithTwo();
      await snapshots.capture(boardId); // bản ở seq 2: e1, e2
      const [target] = await snapshotsOf(boardId);
      await boards.submitOps(boardId, owner.id, [del('e1'), add('e3')]); // seq 3, 4: còn e2, e3
      const e2Before = (await prisma.element.findUniqueOrThrow({ where: { boardId_id: { boardId, id: 'e2' } } })).version;

      const watcher = await connect(app, editor.token);
      clients.push(watcher);
      await watcher.emitWithAck('JoinBoard', joinPayload(boardId));
      const reset = nextEvent(watcher, 'BoardReset');

      const { body } = await api(editor.token).post(`/boards/${boardId}/snapshots/${target!.id}/restore`).expect(200);
      expect(body).toEqual({ seq: 5 });
      await expect(reset).resolves.toEqual({ seq: 5 });

      expect(await visibleIds(boardId)).toEqual(['e1', 'e2']);
      const e3 = await prisma.element.findUniqueOrThrow({ where: { boardId_id: { boardId, id: 'e3' } } });
      expect(e3.isDeleted).toBe(true);
      const e2 = await prisma.element.findUniqueOrThrow({ where: { boardId_id: { boardId, id: 'e2' } } });
      expect(e2.version).toBeGreaterThan(e2Before); // client còn giữ bản cũ thì sửa sẽ thành stale (LWW), không âm thầm khớp

      const all = await snapshotsOf(boardId);
      expect(all.map((s) => [s.seq, s.label])).toEqual([[2, null], [4, 'before-restore']]);
      const op = await prisma.operation.findUniqueOrThrow({ where: { boardId_seq: { boardId, seq: 5 } } });
      expect(op).toMatchObject({ type: 'restore_snapshot', actor: editor.id, payload: { snapshotId: target!.id } });

      // Khôi phục nhầm -> khôi phục lại bản before-restore: về đúng e2, e3
      await api(editor.token).post(`/boards/${boardId}/snapshots/${all[1]!.id}/restore`).expect(200);
      expect(await visibleIds(boardId)).toEqual(['e2', 'e3']);
    });

    it('client nối lại qua op restore_snapshot -> nhận BoardState (không phải MissedOps)', async () => {
      const { owner, boardId } = await boardWithTwo();
      await snapshots.capture(boardId);
      const [target] = await snapshotsOf(boardId);
      await api(owner.token).post(`/boards/${boardId}/snapshots/${target!.id}/restore`).expect(200);
      await boards.submitOps(boardId, owner.id, [add('e9')]); // thêm op thường sau restore

      await expect(boards.getMissedOps(boardId, 2)).resolves.toBeNull();
      await expect(boards.getMissedOps(boardId, 3)).resolves.toHaveLength(1); // đã qua mốc restore -> phát lại bình thường

      const c = await connect(app, owner.token);
      clients.push(c);
      const state = nextEvent<{ lastSeq: number }>(c, 'BoardState');
      await c.emitWithAck('JoinBoard', { ...joinPayload(boardId), lastSeq: 2 });
      await expect(state).resolves.toMatchObject({ lastSeq: 4 });
    });

    it('VIEWER -> 403; snapshot không có -> 404; id sai định dạng -> 400', async () => {
      const { owner, boardId } = await boardWithTwo();
      const viewer = await createUser(app);
      await prisma.boardMember.create({ data: { boardId, userId: viewer.id, role: 'VIEWER' } });
      await snapshots.capture(boardId);
      const [target] = await snapshotsOf(boardId);

      expect(codeOf(await api(viewer.token).post(`/boards/${boardId}/snapshots/${target!.id}/restore`).expect(403))).toBe('BOARD_FORBIDDEN');
      await api(viewer.token).get(`/boards/${boardId}/snapshots`).expect(200); // xem thì được
      expect(codeOf(await api(owner.token).post(`/boards/${boardId}/snapshots/${randomUUID()}/restore`).expect(404))).toBe('SNAPSHOT_NOT_FOUND');
      await api(owner.token).post(`/boards/${boardId}/snapshots/nope/restore`).expect(400);
      expect(await prisma.operation.count({ where: { boardId, type: 'restore_snapshot' } })).toBe(0);
    });
  });

  describe('dọn op cũ', () => {
    it('xóa op đã nằm trong bản chụp VÀ cũ hơn 30 ngày; op sau bản chụp / bảng chưa chụp giữ nguyên; nối lại từ seq cũ -> BoardState', async () => {
      const { owner, boardId } = await boardWithTwo();
      await snapshots.capture(boardId); // bao seq 1, 2
      await boards.submitOps(boardId, owner.id, [add('e3')]); // seq 3, chưa chụp
      const unsnapped = await boardWithTwo();
      const old = new Date(Date.now() - 31 * 24 * 3600_000);
      await prisma.operation.updateMany({ where: { boardId: { in: [boardId, unsnapped.boardId] } }, data: { createdAt: old } });

      await scheduler.pruneOperations();
      expect((await prisma.operation.findMany({ where: { boardId }, orderBy: { seq: 'asc' } })).map((o) => o.seq)).toEqual([3]);
      expect(await prisma.operation.count({ where: { boardId: unsnapped.boardId } })).toBe(2);
      await expect(boards.getMissedOps(boardId, 0)).resolves.toBeNull(); // hổng seq 1-2
      await expect(boards.getMissedOps(boardId, 2)).resolves.toHaveLength(1);
    });
  });
});
