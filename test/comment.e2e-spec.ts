import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';
import { connect, createBoard, createUser, joinPayload, nextEvent, sleep } from './helpers.js';

async function startNode() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await setupApp(app);
  await app.listen(0);
  return app;
}

describe('Bình luận + mention + thông báo (e2e)', () => {
  let app: INestApplication;
  let nodeB: INestApplication; // người được nhắc nối vào node khác -> thông báo vẫn tới (room user: qua Redis)
  let prisma: PrismaService;
  const clients: Socket[] = [];
  const open = async (token: string, node = app) => {
    const c = await connect(node, token);
    clients.push(c);
    return c;
  };
  const api = (token: string) => {
    const http = request(app.getHttpServer());
    const auth = <T extends { set: (k: string, v: string) => T }>(r: T) => r.set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(http.get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => auth(http.post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) => auth(http.patch(`/api/v1${path}`)).send(body),
      delete: (path: string) => auth(http.delete(`/api/v1${path}`)),
    };
  };
  const codeOf = (res: { body: { errors: { code: string }[] } }) => res.body.errors[0]?.code;
  const notificationsOf = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  // A chủ bảng, B EDITOR, C COMMENTER, V VIEWER
  const team = async () => {
    const [a, b, c, v] = [await createUser(app), await createUser(app), await createUser(app), await createUser(app)];
    const board = await createBoard(app, a.id, [b.id]);
    await prisma.boardMember.createMany({
      data: [
        { boardId: board.id, userId: c.id, role: 'COMMENTER' },
        { boardId: board.id, userId: v.id, role: 'VIEWER' },
      ],
    });
    return { a, b, c, v, boardId: board.id, path: `/boards/${board.id}/comments` };
  };

  beforeAll(async () => {
    [app, nodeB] = await Promise.all([startNode(), startNode()]);
    prisma = app.get(PrismaService);
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
    await Promise.all([app.close(), nodeB.close()]);
  });

  describe('tạo + xem', () => {
    it('COMMENTER bình luận vào một điểm -> 201 kèm tác giả; cả phòng nhận CommentAdded; GET trả danh sách', async () => {
      const { a, c, boardId, path } = await team();
      const watcher = await open(a.token);
      await watcher.emitWithAck('JoinBoard', joinPayload(boardId));
      const added = nextEvent(watcher, 'CommentAdded');

      const { body } = await api(c.token).post(path, { body: '  Chỗ này lệch  ', x: 10, y: 20 }).expect(201);
      expect(body).toEqual({
        id: expect.any(String),
        boardId,
        parentId: null,
        elementId: null,
        x: 10,
        y: 20,
        body: 'Chỗ này lệch',
        resolvedAt: null,
        createdAt: expect.any(String),
        author: { id: c.id, displayName: 'E2E', avatarUrl: null },
      });
      await expect(added).resolves.toEqual(body);
      await expect(api(a.token).get(path).expect(200)).resolves.toMatchObject({ body: [body] });
    });

    it('VIEWER không bình luận được (403) nhưng xem được; người lạ -> 404; gắn sai (cả element lẫn điểm) -> 400', async () => {
      const { a, v, path } = await team();
      const stranger = await createUser(app);
      expect(codeOf(await api(v.token).post(path, { body: 'x', x: 0, y: 0 }).expect(403))).toBe('BOARD_FORBIDDEN');
      await api(v.token).get(path).expect(200);
      expect(codeOf(await api(stranger.token).get(path).expect(404))).toBe('BOARD_NOT_FOUND');
      await api(a.token).post(path, { body: 'x', elementId: 'r1', x: 0, y: 0 }).expect(400);
    });
  });

  describe('mention + thông báo', () => {
    it('B được @ và đang online (ở node khác, không mở bảng) -> nhận NotificationCreated; người ngoài bảng được @ -> KHÔNG có thông báo; tự @ mình -> bỏ qua', async () => {
      const { a, b, path } = await team();
      const outsider = await createUser(app);
      const bSocket = await open(b.token, nodeB);
      const got = nextEvent<Record<string, unknown>>(bSocket, 'NotificationCreated');

      const { body: comment } = await api(a.token).post(path, { body: 'Xem giúp nhé', elementId: 'r1', mentions: [b.id, outsider.id, a.id] }).expect(201);
      await expect(got).resolves.toEqual({
        id: expect.any(String),
        type: 'MENTION',
        actorId: a.id,
        boardId: comment.boardId,
        commentId: comment.id,
        data: { boardTitle: 'Untitled', authorName: 'E2E', excerpt: 'Xem giúp nhé' },
        readAt: null,
        createdAt: expect.any(String),
      });
      expect(await notificationsOf(outsider.id)).toEqual([]);
      expect(await notificationsOf(a.id)).toEqual([]);
    });

    it('trả lời: tác giả comment gốc nhận COMMENT_REPLY; vừa là tác giả gốc vừa được @ -> chỉ 1 thông báo MENTION; tự trả lời mình -> không báo', async () => {
      const { a, b, c, path } = await team();
      const { body: root } = await api(b.token).post(path, { body: 'Gốc', x: 0, y: 0 }).expect(201);

      await api(c.token).post(path, { body: 'Trả lời', parentId: root.id }).expect(201);
      await api(a.token).post(path, { body: 'Trả lời + @', parentId: root.id, mentions: [b.id] }).expect(201);
      await api(b.token).post(path, { body: 'Tự trả lời', parentId: root.id }).expect(201);
      expect((await notificationsOf(b.id)).map((n) => [n.type, n.actorId])).toEqual([
        ['COMMENT_REPLY', c.id],
        ['MENTION', a.id],
      ]);
    });

    it('trả lời một câu trả lời / comment của bảng khác / id bịa -> 400 INVALID_PARENT_COMMENT, không lưu gì', async () => {
      const { a, path } = await team();
      const other = await team();
      const { body: root } = await api(a.token).post(path, { body: 'Gốc', x: 0, y: 0 }).expect(201);
      const { body: reply } = await api(a.token).post(path, { body: 'Con', parentId: root.id }).expect(201);
      const { body: foreign } = await api(other.a.token).post(other.path, { body: 'Bảng khác', x: 0, y: 0 }).expect(201);

      for (const parentId of [reply.id, foreign.id, randomUUID()]) {
        expect(codeOf(await api(a.token).post(path, { body: 'x', parentId }).expect(400))).toBe('INVALID_PARENT_COMMENT');
      }
      expect((await api(a.token).get(path).expect(200)).body).toHaveLength(2);
    });

    it('GET /notifications: mới nhất trước + số chưa đọc; đọc 1 cái, đọc hết; không đánh dấu được thông báo của người khác', async () => {
      const { a, b, c, path } = await team();
      await api(a.token).post(path, { body: 'một', x: 0, y: 0, mentions: [b.id] }).expect(201);
      await sleep(5);
      await api(c.token).post(path, { body: 'hai', x: 0, y: 0, mentions: [b.id] }).expect(201);

      const { body: list } = await api(b.token).get('/notifications').expect(200);
      expect(list.unread).toBe(2);
      expect(list.items.map((n: { data: { excerpt: string } }) => n.data.excerpt)).toEqual(['hai', 'một']);

      await api(c.token).post(`/notifications/${list.items[0].id}/read`).expect(204); // của B, C bấm -> không có tác dụng
      expect((await api(b.token).get('/notifications').expect(200)).body.unread).toBe(2);
      await api(b.token).post(`/notifications/${list.items[0].id}/read`).expect(204);
      const after = (await api(b.token).get('/notifications?unread=true').expect(200)).body;
      expect([after.unread, after.items.length]).toEqual([1, 1]);
      await api(b.token).post('/notifications/read-all').expect(204);
      expect((await api(b.token).get('/notifications').expect(200)).body.unread).toBe(0);
      await api(b.token).get('/notifications?unread=yes').expect(400);
    });
  });

  describe('sửa / xử lý / xóa', () => {
    it('người khác đánh dấu đã xử lý được (phòng nhận CommentUpdated), mở lại được; sửa nội dung chỉ tác giả', async () => {
      const { a, b, boardId, path } = await team();
      const { body: comment } = await api(b.token).post(path, { body: 'Gốc', x: 0, y: 0 }).expect(201);
      const watcher = await open(b.token);
      await watcher.emitWithAck('JoinBoard', joinPayload(boardId));
      const updated = nextEvent<{ resolvedAt: string | null }>(watcher, 'CommentUpdated');

      const { body } = await api(a.token).patch(`${path}/${comment.id}`, { resolved: true }).expect(200);
      expect(body.resolvedAt).toEqual(expect.any(String));
      await expect(updated).resolves.toMatchObject({ id: comment.id, resolvedAt: expect.any(String) });
      expect((await api(a.token).patch(`${path}/${comment.id}`, { resolved: false }).expect(200)).body.resolvedAt).toBeNull();

      expect(codeOf(await api(a.token).patch(`${path}/${comment.id}`, { body: 'Sửa hộ' }).expect(403))).toBe('NOT_COMMENT_AUTHOR');
      expect((await api(b.token).patch(`${path}/${comment.id}`, { body: 'Đã sửa' }).expect(200)).body.body).toBe('Đã sửa');
      expect(codeOf(await api(a.token).patch(`${path}/${randomUUID()}`, { resolved: true }).expect(404))).toBe('COMMENT_NOT_FOUND');
    });

    it('xóa: tác giả hoặc chủ bảng (EDITOR khác -> 403); xóa gốc thì trả lời + thông báo đi theo; phòng nhận CommentDeleted', async () => {
      const { a, b, c, boardId, path } = await team();
      const { body: root } = await api(c.token).post(path, { body: 'Gốc', x: 0, y: 0 }).expect(201);
      await api(b.token).post(path, { body: 'Con', parentId: root.id }).expect(201);
      expect(codeOf(await api(b.token).delete(`${path}/${root.id}`).expect(403))).toBe('NOT_COMMENT_AUTHOR');

      const watcher = await open(b.token);
      await watcher.emitWithAck('JoinBoard', joinPayload(boardId));
      const deleted = nextEvent(watcher, 'CommentDeleted');
      await api(a.token).delete(`${path}/${root.id}`).expect(204);
      await expect(deleted).resolves.toEqual({ id: root.id });
      expect((await api(a.token).get(path).expect(200)).body).toEqual([]);
      expect(await notificationsOf(c.id)).toEqual([]); // COMMENT_REPLY gửi C đã xóa theo comment
    });
  });
});
