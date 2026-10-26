import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { SocketEmitter } from '../src/infra/socket/socket-emitter.service.js';
import { BoardGateway } from '../src/modules/realtime/board.gateway.js';

// Hai instance của app trong cùng process = hai "server" sau load balancer, nối nhau qua Redis.
async function startNode() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await setupApp(app);
  await app.listen(0);
  return app;
}

async function connect(app: INestApplication) {
  const client = io(await app.getUrl(), { transports: ['websocket'], forceNew: true });
  await new Promise<void>((ok, fail) => {
    client.once('connect', ok);
    client.once('connect_error', fail);
  });
  return client;
}

describe('Nhiều server qua Redis adapter (e2e)', () => {
  let nodeA: INestApplication;
  let nodeB: INestApplication;
  const clients: Socket[] = [];

  beforeAll(async () => {
    [nodeA, nodeB] = await Promise.all([startNode(), startNode()]);
  });

  afterAll(async () => {
    clients.forEach((c) => c.disconnect());
    await Promise.all([nodeA.close(), nodeB.close()]);
  });

  it('SocketEmitter ở server A phát tới client đang nối server B', async () => {
    const boardId = randomUUID();
    const onB = await connect(nodeB);
    clients.push(onB);
    await onB.emitWithAck('JoinBoard', { boardId, displayName: 'B', clientId: randomUUID() });

    const received = new Promise((r) => onB.once('CrossNodePing', r));
    nodeA.get(SocketEmitter).toBoard(boardId, 'CrossNodePing', { from: 'A' });

    await expect(received).resolves.toEqual({ from: 'A' });
  });

  it('kickFromBoard ở server A: client ở server B nhận AccessChanged rồi bị ngắt (8.2)', async () => {
    const boardId = randomUUID();
    const onB = await connect(nodeB);
    clients.push(onB);
    await onB.emitWithAck('JoinBoard', { boardId, displayName: 'B', clientId: randomUUID() });

    const accessChanged = new Promise((r) => onB.once('AccessChanged', r));
    const disconnected = new Promise((r) => onB.once('disconnect', r));
    nodeA.get(SocketEmitter).kickFromBoard(`board:${boardId}`, 'revoked');

    await expect(accessChanged).resolves.toEqual({ reason: 'revoked' });
    await expect(disconnected).resolves.toBe('io server disconnect'); // client KHÔNG tự kết nối lại sau lý do này
  });

  it('gateway được khởi tạo trên cả hai node', () => {
    expect(nodeA.get(BoardGateway)).toBeDefined();
    expect(nodeB.get(BoardGateway)).toBeDefined();
  });
});
