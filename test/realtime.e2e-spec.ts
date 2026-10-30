import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { connect, createBoard, createUser, joinPayload, nextEvent, sleep } from './helpers.js';

const RECT = { x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: '#000000', fillColor: 'transparent', strokeWidth: 1, strokeStyle: 'solid', opacity: 1 };
const addOp = (id = randomUUID()) => ({ opId: randomUUID(), type: 'add', element: { id, type: 'rect', data: RECT } });

type BoardState = { lastSeq: number; elements: { id: string }[]; users: { userId: string }[] };

describe('Socket.IO gateway (e2e)', () => {
  let app: INestApplication;
  const clients: Socket[] = [];
  const open = async (token: string) => {
    const c = await connect(app, token);
    clients.push(c);
    return c;
  };
  // Lắng nghe BoardState TRƯỚC khi gửi JoinBoard: server emit nó trước khi trả ack
  const join = async (c: Socket, boardId: string) => {
    const state = nextEvent<BoardState>(c, 'BoardState');
    const ack = await c.emitWithAck('JoinBoard', joinPayload(boardId));
    return { ack, state: await state };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await setupApp(app);
    await app.listen(0); // init() chưa đủ: gateway chỉ nhận kết nối sau listen
  });

  afterEach(() => {
    clients.splice(0).forEach((c) => c.disconnect());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('xác thực lúc bắt tay', () => {
    it('không token / token sai chữ ký -> connect_error "unauthorized"', async () => {
      await expect(connect(app)).rejects.toThrow('unauthorized');
      const forged = await new JwtService({ secret: 'wrong-secret' }).signAsync({ sub: randomUUID() });
      await expect(connect(app, forged)).rejects.toThrow('unauthorized');
    });

    it('token hết hạn giữa chừng -> AuthExpired rồi bị server ngắt', async () => {
      const user = await createUser(app, { expiresIn: 1 });
      const c = await open(user.token);
      const expired = nextEvent(c, 'AuthExpired');
      const disconnected = nextEvent(c, 'disconnect');
      await expired;
      await expect(disconnected).resolves.toBe('io server disconnect');
    });
  });

  describe('JoinBoard', () => {
    it('bảng không tồn tại -> ack { ok:false, not_found }', async () => {
      const c = await open((await createUser(app)).token);
      await expect(c.emitWithAck('JoinBoard', joinPayload(randomUUID()))).resolves.toEqual({ ok: false, reason: 'not_found' });
    });

    it('payload sai -> exception { errors } cùng dạng HTTP, không dội payload', async () => {
      const c = await open((await createUser(app)).token);
      const err = nextEvent<Record<string, unknown>>(c, 'exception');
      c.emit('JoinBoard', { boardId: 'nope', displayName: 'An', clientId: randomUUID(), sneaky: 1 });
      const e = await err;
      expect(e['errors']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'boardId' })]));
      expect(JSON.stringify(e)).not.toContain('nope');
    });

    it('chủ bảng vào -> ack role OWNER + BoardState (rỗng, lastSeq 0, có chính mình trong users)', async () => {
      const owner = await createUser(app);
      const board = await createBoard(app, owner.id);
      const { ack, state } = await join(await open(owner.token), board.id);
      expect(ack).toEqual({ ok: true, role: 'OWNER' });
      expect(state).toEqual({ lastSeq: 0, elements: [], users: [expect.objectContaining({ userId: owner.id, color: expect.any(String) })] });
    });
  });

  describe('vẽ chung', () => {
    it('A vẽ -> A và B cùng nhận OpsApplied; A nhận ack có seq; người vào sau (F5) thấy hình trong BoardState', async () => {
      const [ua, ub] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, ua.id);
      const a = await open(ua.token);
      const b = await open(ub.token);
      await join(a, board.id);
      const joinedEvt = nextEvent<{ userId: string }>(a, 'UserJoined');
      await join(b, board.id);
      await expect(joinedEvt).resolves.toMatchObject({ userId: ub.id });

      const op = addOp();
      const onA = nextEvent<{ opId: string; seq: number }[]>(a, 'OpsApplied');
      const onB = nextEvent<{ opId: string; seq: number }[]>(b, 'OpsApplied');
      const ack = await a.emitWithAck('SubmitOps', { ops: [op] });

      expect(ack).toEqual({ ok: true, applied: [{ opId: op.opId, seq: 1 }], rejected: [], duplicates: [] });
      for (const got of [await onA, await onB]) expect(got).toEqual([expect.objectContaining({ opId: op.opId, seq: 1, element: expect.objectContaining({ id: op.element.id, version: 1 }) })]);

      const { state } = await join(await open(ub.token), board.id);
      expect(state.lastSeq).toBe(1);
      expect(state.elements.map((e) => e.id)).toEqual([op.element.id]);
      expect(state.users.map((u) => u.userId).sort()).toEqual([ua.id, ub.id].sort()); // B mở 2 tab -> vẫn 1 dòng
    });

    it('op bị từ chối: OpRejected chỉ tới người gửi, ack ghi lý do; B không nhận gì', async () => {
      const [ua, ub] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, ua.id);
      const [a, b] = [await open(ua.token), await open(ub.token)];
      await join(a, board.id);
      await join(b, board.id);

      let bGotSomething = false;
      b.on('OpRejected', () => (bGotSomething = true));
      b.on('OpsApplied', () => (bGotSomething = true));
      const op = { opId: randomUUID(), type: 'delete', elementId: 'ghost' };
      const rejected = nextEvent(a, 'OpRejected');
      const ack = await a.emitWithAck('SubmitOps', { ops: [op] });

      expect(ack).toEqual({ ok: true, applied: [], rejected: [{ opId: op.opId, reason: 'not_found' }], duplicates: [] });
      await expect(rejected).resolves.toEqual({ opId: op.opId, reason: 'not_found' });
      await sleep(100);
      expect(bGotSomething).toBe(false);
    });

    it('A rớt mạng, B vẽ 3 op, A nối lại với lastSeq -> nhận MissedOps đúng 3 op, KHÔNG nhận BoardState', async () => {
      const [ua, ub] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, ua.id);
      const a = await open(ua.token);
      const b = await open(ub.token);
      await join(a, board.id);
      await join(b, board.id);
      await a.emitWithAck('SubmitOps', { ops: [addOp()] }); // seq 1: A đã thấy
      a.disconnect();

      const ops = [addOp(), addOp(), addOp()];
      await b.emitWithAck('SubmitOps', { ops: ops.slice(0, 2) });
      await b.emitWithAck('SubmitOps', { ops: ops.slice(2) });

      const a2 = await open(ua.token);
      let gotState = false;
      a2.on('BoardState', () => (gotState = true));
      const missed = nextEvent<{ ops: { seq: number; opId: string }[]; users: { userId: string }[] }>(a2, 'MissedOps');
      await expect(a2.emitWithAck('JoinBoard', { ...joinPayload(board.id), lastSeq: 1 })).resolves.toEqual({ ok: true, role: 'OWNER' });
      const m = await missed;
      expect(m.ops.map((o) => [o.seq, o.opId])).toEqual(ops.map((o, i) => [i + 2, o.opId]));
      expect(m.users.map((u) => u.userId).sort()).toEqual([ua.id, ub.id].sort());
      expect(gotState).toBe(false);
    });

    it('mất ack nên gửi lại cùng lô -> ack duplicates với seq cũ, B không nhận OpsApplied lần 2', async () => {
      const [ua, ub] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, ua.id);
      const [a, b] = [await open(ua.token), await open(ub.token)];
      await join(a, board.id);
      await join(b, board.id);
      const op = addOp();
      await a.emitWithAck('SubmitOps', { ops: [op] });
      await sleep(50);

      let bCount = 0;
      b.on('OpsApplied', () => bCount++);
      const ack = await a.emitWithAck('SubmitOps', { ops: [op] });
      expect(ack).toEqual({ ok: true, applied: [], rejected: [], duplicates: [{ opId: op.opId, seq: 1 }] });
      await sleep(100);
      expect(bCount).toBe(0);
    });

    it('SubmitOps trước JoinBoard -> ack not_joined (tin đệm gửi lại sau khi nối lại)', async () => {
      const c = await open((await createUser(app)).token);
      await expect(c.emitWithAck('SubmitOps', { ops: [addOp()] })).resolves.toEqual({ ok: false, reason: 'not_joined' });
    });
  });

  describe('rời phòng', () => {
    it('người có 2 tab đóng 1 tab -> KHÔNG UserLeft; đóng tab cuối -> UserLeft', async () => {
      const [ua, ub] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, ua.id);
      const a = await open(ua.token);
      await join(a, board.id);
      const [tab1, tab2] = [await open(ub.token), await open(ub.token)];
      await join(tab1, board.id);
      await join(tab2, board.id);

      const left: unknown[] = [];
      a.on('UserLeft', (e) => left.push(e));
      tab1.disconnect();
      await sleep(150);
      expect(left).toEqual([]);

      tab2.disconnect();
      await sleep(150);
      expect(left).toEqual([{ userId: ub.id }]);
    });

    it('JoinBoard sang bảng khác: rời bảng cũ (UserLeft ở bảng cũ), không còn nhận OpsApplied của bảng cũ', async () => {
      const [ua, ub] = [await createUser(app), await createUser(app)];
      const [b1, b2] = [await createBoard(app, ua.id), await createBoard(app, ub.id)];
      const a = await open(ua.token);
      const b = await open(ub.token);
      await join(a, b1.id);
      await join(b, b1.id);

      const left = nextEvent(a, 'UserLeft');
      await join(b, b2.id);
      await expect(left).resolves.toEqual({ userId: ub.id });

      let bGotOld = false;
      b.on('OpsApplied', () => (bGotOld = true));
      await a.emitWithAck('SubmitOps', { ops: [addOp()] });
      await sleep(100);
      expect(bGotOld).toBe(false);
    });
  });
});
