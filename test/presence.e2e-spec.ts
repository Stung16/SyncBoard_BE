import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { connect, createBoard, createUser, joinPayload, nextEvent, sleep } from './helpers.js';

const TEXT = { x: 0, y: 0, width: 200, text: '', fontSize: 16, color: '#1e1e1e', align: 'left' };

type Selections = { userId: string; clientId: string; elementIds: string[]; editingElementId: string | null }[];

describe('Presence, sự kiện tạm, khóa mềm, chống spam (e2e)', () => {
  let app: INestApplication;
  const clients: Socket[] = [];
  const open = async (token: string) => {
    const c = await connect(app, token);
    clients.push(c);
    return c;
  };
  // Bảng có A (chủ) và B (EDITOR), cả hai đã vào phòng
  const room2 = async () => {
    const [ua, ub] = [await createUser(app), await createUser(app)];
    const board = await createBoard(app, ua.id, [ub.id]);
    const [a, b] = [await open(ua.token), await open(ub.token)];
    await a.emitWithAck('JoinBoard', joinPayload(board.id));
    await b.emitWithAck('JoinBoard', joinPayload(board.id));
    return { ua, ub, boardId: board.id, a, b };
  };
  const collect = (c: Socket, event: string) => {
    const got: unknown[] = [];
    c.on(event, (e) => got.push(e));
    return got;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.listen(0);
  });

  afterEach(() => {
    clients.splice(0).forEach((c) => c.disconnect());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('chuyển tiếp sự kiện tạm', () => {
    it('UpdateCursor: B nhận CursorMoved kèm userId của A do SERVER gắn; A không nhận lại của chính mình', async () => {
      const { ua, a, b } = await room2();
      const onA = collect(a, 'CursorMoved');
      const moved = nextEvent(b, 'CursorMoved');
      a.emit('UpdateCursor', { x: 10, y: 20 });
      await expect(moved).resolves.toEqual({ userId: ua.id, clientId: expect.any(String), x: 10, y: 20 });
      await sleep(50);
      expect(onA).toEqual([]);
    });

    it('client tự gửi userId (giả làm người khác) -> bị từ chối (exception), B không nhận gì', async () => {
      const { a, b } = await room2();
      const onB = collect(b, 'CursorMoved');
      const err = nextEvent<{ errors: { code: string }[] }>(a, 'exception');
      a.emit('UpdateCursor', { x: 1, y: 1, userId: randomUUID() });
      await expect(err).resolves.toMatchObject({ errors: [{ code: 'VALIDATION_ERROR' }] });
      await sleep(50);
      expect(onB).toEqual([]);
    });

    it('UpdateViewport -> ViewportChanged; SendEphemeral laser -> Ephemeral', async () => {
      const { ua, a, b } = await room2();
      const vp = nextEvent(b, 'ViewportChanged');
      a.emit('UpdateViewport', { x: 1, y: 2, zoom: 1.5 });
      await expect(vp).resolves.toMatchObject({ userId: ua.id, x: 1, y: 2, zoom: 1.5 });

      const eph = nextEvent(b, 'Ephemeral');
      a.emit('SendEphemeral', { kind: 'laser', payload: { x: 5, y: 6 } });
      await expect(eph).resolves.toMatchObject({ userId: ua.id, kind: 'laser', payload: { x: 5, y: 6 } });
    });

    it('cursorChat quá 100 ký tự / kind lạ -> exception', async () => {
      const { a } = await room2();
      for (const bad of [{ kind: 'cursorChat', payload: { text: 'x'.repeat(101) } }, { kind: 'fireworks', payload: {} }]) {
        const err = nextEvent(a, 'exception');
        a.emit('SendEphemeral', bad);
        await expect(err).resolves.toMatchObject({ errors: expect.any(Array) });
      }
    });

    it('VIEWER không gửi được con trỏ (bỏ qua im lặng)', async () => {
      const { boardId, b } = await room2();
      const viewer = await createUser(app);
      await app.get(PrismaService).boardMember.create({ data: { boardId, userId: viewer.id, role: 'VIEWER' } });
      const v = await open(viewer.token);
      await expect(v.emitWithAck('JoinBoard', joinPayload(boardId))).resolves.toEqual({ ok: true, role: 'VIEWER' });

      const onB = collect(b, 'CursorMoved');
      v.emit('UpdateCursor', { x: 1, y: 1 });
      await sleep(100);
      expect(onB).toEqual([]);
    });

    it('Ping -> Pong { clientTime, serverTime }', async () => {
      const { a } = await room2();
      const pong = nextEvent<{ clientTime: number; serverTime: number }>(a, 'Pong');
      a.emit('Ping', { clientTime: 123 });
      const p = await pong;
      expect(p.clientTime).toBe(123);
      expect(Math.abs(p.serverTime - Date.now())).toBeLessThan(1000);
    });
  });

  describe('vùng chọn + khóa mềm ô chữ', () => {
    it('A chọn -> B nhận SelectionChanged; người vào sau thấy vùng chọn của A trong BoardState', async () => {
      const { ua, ub, boardId, a, b } = await room2();
      const changed = nextEvent(b, 'SelectionChanged');
      await expect(a.emitWithAck('UpdateSelection', { elementIds: ['e1', 'e2'] })).resolves.toEqual({ ok: true });
      await expect(changed).resolves.toMatchObject({ userId: ua.id, elementIds: ['e1', 'e2'], editingElementId: null });

      const late = await open(ub.token);
      const state = nextEvent<{ selections: Selections }>(late, 'BoardState');
      await late.emitWithAck('JoinBoard', joinPayload(boardId));
      expect((await state).selections).toEqual([expect.objectContaining({ userId: ua.id, elementIds: ['e1', 'e2'] })]);
    });

    it('A đang sửa ô chữ: B không xin sửa được, op sửa text của B bị being_edited, op sửa vị trí vẫn qua', async () => {
      const { ua, a, b } = await room2();
      const t1 = randomUUID();
      await a.emitWithAck('SubmitOps', { ops: [{ opId: randomUUID(), type: 'add', element: { id: t1, type: 'text', data: TEXT } }] });
      await expect(a.emitWithAck('UpdateSelection', { elementIds: [t1], editingElementId: t1 })).resolves.toEqual({ ok: true });

      await expect(b.emitWithAck('UpdateSelection', { elementIds: [t1], editingElementId: t1 })).resolves.toEqual({
        ok: false,
        reason: 'being_edited',
        by: ua.id,
      });

      const textOp = { opId: randomUUID(), type: 'update', elementId: t1, baseVersion: 1, patch: { text: 'B chen ngang' } };
      const moveOp = { opId: randomUUID(), type: 'update', elementId: t1, baseVersion: 1, patch: { x: 50 } };
      const rejected = nextEvent(b, 'OpRejected');
      const ack = await b.emitWithAck('SubmitOps', { ops: [textOp, moveOp] });
      expect(ack).toEqual({ ok: true, applied: [{ opId: moveOp.opId, seq: 2 }], rejected: [{ opId: textOp.opId, reason: 'being_edited' }], duplicates: [] });
      await expect(rejected).resolves.toEqual({ opId: textOp.opId, reason: 'being_edited' });

      // Chính A thì gõ được
      const own = await a.emitWithAck('SubmitOps', { ops: [{ opId: randomUUID(), type: 'update', elementId: t1, baseVersion: 2, patch: { text: 'Xin chào' } }] });
      expect(own.applied).toHaveLength(1);
    });

    it('A rớt mạng -> B nhận SelectionChanged rỗng (khóa được nhả) và giờ xin sửa được', async () => {
      const { ua, a, b } = await room2();
      const acquired = nextEvent(b, 'SelectionChanged');
      await a.emitWithAck('UpdateSelection', { elementIds: ['t9'], editingElementId: 't9' });
      await acquired; // tin "A đang sửa" tới B trước
      const released = nextEvent(b, 'SelectionChanged');
      a.disconnect();
      await expect(released).resolves.toMatchObject({ userId: ua.id, elementIds: [], editingElementId: null });
      await expect(b.emitWithAck('UpdateSelection', { elementIds: ['t9'], editingElementId: 't9' })).resolves.toEqual({ ok: true });
    });
  });

  describe('chống spam (token bucket)', () => {
    it('A bắn 120 con trỏ một lúc -> B chỉ nhận khoảng 30 (phần còn lại bị bỏ), A vẫn còn kết nối', async () => {
      const { a, b } = await room2();
      const onB = collect(b, 'CursorMoved');
      for (let i = 0; i < 120; i++) a.emit('UpdateCursor', { x: i, y: i });
      await sleep(300);
      expect(onB.length).toBeGreaterThan(0);
      expect(onB.length).toBeLessThanOrEqual(40);
      expect(a.connected).toBe(true);
    });

    it('spam kéo dài (bị chặn > 100 tin) -> server ngắt kết nối', async () => {
      const { a } = await room2();
      const gone = nextEvent(a, 'disconnect');
      for (let i = 0; i < 300; i++) a.emit('UpdateCursor', { x: i, y: i });
      await expect(gone).resolves.toBe('io server disconnect');
    });
  });
});
