import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';

describe('Socket.IO gateway (e2e)', () => {
  let app: INestApplication;
  let url: string;
  let client: Socket;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.listen(0); // init() chưa đủ: gateway chỉ nhận kết nối sau listen
    url = await app.getUrl();
  });

  beforeEach(async () => {
    client = io(url, { transports: ['websocket'], forceNew: true });
    await new Promise<void>((ok, fail) => {
      client.once('connect', ok);
      client.once('connect_error', fail);
    });
  });

  afterEach(() => {
    client.disconnect();
  });

  afterAll(async () => {
    await app.close();
  });

  it('JoinBoard hợp lệ -> ack ok', async () => {
    const ack = await client.emitWithAck('JoinBoard', {
      boardId: randomUUID(),
      displayName: 'An',
      clientId: randomUUID(),
    });
    expect(ack).toEqual({ ok: true });
  });

  it('JoinBoard sai -> exception có message, không dội payload', async () => {
    const err = new Promise<Record<string, unknown>>((r) => client.once('exception', r));
    client.emit('JoinBoard', { boardId: 'nope', displayName: 'An', clientId: randomUUID(), sneaky: 1 });
    const e = await err;
    expect(e['message']).toEqual(expect.arrayContaining([expect.stringContaining('boardId')]));
    expect(JSON.stringify(e)).not.toContain('nope');
  });
});
