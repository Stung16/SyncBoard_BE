import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { SocketEmitter } from '../src/infra/socket/socket-emitter.service.js';
import { BoardGateway } from '../src/modules/realtime/board.gateway.js';
import { connect, createBoard, createUser, joinPayload, sleep } from './helpers.js';

// Hai instance của app trong cùng process = hai "server" sau load balancer, nối nhau qua Redis.
async function startNode() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await setupApp(app);
  await app.listen(0);
  return app;
}

describe('Nhiều server qua Redis adapter (e2e)', () => {
  let nodeA: INestApplication;
  let nodeB: INestApplication;
  const clients: Socket[] = [];
  const open = async (app: INestApplication, token: string) => {
    const c = await connect(app, token);
    clients.push(c);
    return c;
  };
  // Bảng thật + client ở node B đã vào phòng
  const joinedOnB = async () => {
    const user = await createUser(nodeA);
    const board = await createBoard(nodeA, user.id);
    const onB = await open(nodeB, user.token);
    await onB.emitWithAck('JoinBoard', joinPayload(board.id));
    return { user, boardId: board.id, onB };
  };

  beforeAll(async () => {
    [nodeA, nodeB] = await Promise.all([startNode(), startNode()]);
  });

  afterAll(async () => {
    clients.forEach((c) => c.disconnect());
    await Promise.all([nodeA.close(), nodeB.close()]);
  });

  it('SocketEmitter ở server A phát tới client đang nối server B', async () => {
    const { boardId, onB } = await joinedOnB();
    const received = new Promise((r) => onB.once('CrossNodePing', r));
    nodeA.get(SocketEmitter).toBoard(boardId, 'CrossNodePing', { from: 'A' });

    await expect(received).resolves.toEqual({ from: 'A' });
  });

  it('kickFromBoard ở server A: client ở server B nhận AccessChanged rồi bị ngắt (8.2)', async () => {
    const { boardId, onB } = await joinedOnB();
    const accessChanged = new Promise((r) => onB.once('AccessChanged', r));
    const disconnected = new Promise((r) => onB.once('disconnect', r));
    nodeA.get(SocketEmitter).kickFromBoard(`board:${boardId}`, 'revoked');

    await expect(accessChanged).resolves.toEqual({ reason: 'revoked' });
    await expect(disconnected).resolves.toBe('io server disconnect'); // client KHÔNG tự kết nối lại sau lý do này
  });

  it('presence qua 2 node: 1 tab ở A + 1 tab ở B cùng người, đóng tab ở B -> KHÔNG UserLeft; người ở A thấy cả 2 trong BoardState', async () => {
    const { user, boardId, onB } = await joinedOnB();
    const watcher = await createUser(nodeA);
    const w = await open(nodeA, watcher.token);
    const state = new Promise<{ users: { userId: string }[] }>((r) => w.once('BoardState', r));
    await w.emitWithAck('JoinBoard', joinPayload(boardId));
    expect((await state).users.map((u) => u.userId).sort()).toEqual([user.id, watcher.id].sort());

    const tabOnA = await open(nodeA, user.token);
    await tabOnA.emitWithAck('JoinBoard', joinPayload(boardId));
    const left: unknown[] = [];
    w.on('UserLeft', (e) => left.push(e));
    onB.disconnect();
    await sleep(200);
    expect(left).toEqual([]);

    tabOnA.disconnect();
    await sleep(200);
    expect(left).toEqual([{ userId: user.id }]);
  });

  it('gateway được khởi tạo trên cả hai node', () => {
    expect(nodeA.get(BoardGateway)).toBeDefined();
    expect(nodeB.get(BoardGateway)).toBeDefined();
  });
});
