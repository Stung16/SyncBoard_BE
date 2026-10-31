import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import type { OpDto } from '../src/modules/board/dto/op.dto.js';
import { BoardLocks } from '../src/modules/board/board-locks.js';
import { BoardService } from '../src/modules/board/services/board.service.js';
import { connect, createBoard, createUser, joinPayload } from './helpers.js';

const RECT = { x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: '#000000', fillColor: 'transparent', strokeWidth: 1, strokeStyle: 'solid', opacity: 1 };
const batch = (n: number): OpDto[] =>
  Array.from({ length: n }, () => ({ opId: randomUUID(), type: 'add', element: { id: randomUUID(), type: 'rect', data: RECT } }) as OpDto);

async function startNode() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await setupApp(app);
  await app.listen(0);
  return app;
}

// app.close() = đúng chuỗi hook mà SIGTERM/SIGINT chạy (enableShutdownHooks). Node "còn sống" để đọc DB sau khi node kia tắt.
describe('Graceful shutdown (e2e)', () => {
  let survivor: INestApplication;

  beforeAll(async () => {
    survivor = await startNode();
  });

  afterAll(async () => {
    await survivor.close();
  });

  it('tắt node khi đang có lô op chạy: lô đã bắt đầu đều commit xong (không lỗi vì DB bị ngắt); lô tới sau -> SHUTTING_DOWN', async () => {
    const dying = await startNode();
    const user = await createUser(dying);
    const boardIds = await Promise.all(Array.from({ length: 5 }, async () => (await createBoard(dying, user.id)).id));
    const boards = dying.get(BoardService);

    // 5 bảng x 4 lô x 50 op đang chạy/xếp hàng thì bắt đầu tắt
    const inFlight = boardIds.flatMap((id) => Array.from({ length: 4 }, () => boards.submitOps(id, user.id, batch(50))));
    const closing = dying.close();
    const locks = dying.get(BoardLocks);
    await vi.waitFor(() => expect(locks['closing']).toBe(true)); // close() tới bước onModuleDestroy (lô vẫn đang chạy)
    const late = boards.submitOps(boardIds[0]!, user.id, batch(1)).catch((e: unknown) => e); // bắt ngay: reject sớm hơn lúc expect
    const results = await Promise.allSettled(inFlight);
    await closing;

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await late).toMatchObject({ code: 'SHUTTING_DOWN' });
    // Đọc bằng node còn sống: mọi op đã ack đều nằm trong DB, seq liên tục
    const prisma = survivor.get(PrismaService);
    for (const id of boardIds) {
      const seqs = (await prisma.operation.findMany({ where: { boardId: id }, select: { seq: true }, orderBy: { seq: 'asc' } })).map((o) => o.seq);
      expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
      await expect(prisma.board.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({ lastSeq: 200 });
    }
  });

  it('SubmitOps qua socket lúc node đang tắt -> ack shutting_down (không phải internal)', async () => {
    const dying = await startNode();
    const user = await createUser(dying);
    const board = await createBoard(dying, user.id);
    const c = await connect(dying, user.token);
    await c.emitWithAck('JoinBoard', joinPayload(board.id));

    await dying.get(BoardLocks).onModuleDestroy(); // bước đầu của close(): socket vẫn mở, khóa đã đóng
    await expect(c.emitWithAck('SubmitOps', { ops: batch(1) })).resolves.toEqual({ ok: false, reason: 'shutting_down' });
    c.disconnect();
    await dying.close();
  });
});
