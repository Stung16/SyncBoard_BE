import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { sha256 } from '../src/common/utils/token.util.js';
import { PrismaService } from '../src/infra/database/prisma.service.js';
import { MailService } from '../src/infra/mail/mail.service.js';
import { REDIS, type RedisClient } from '../src/infra/redis/redis.module.js';
import { connect, createBoard, createUser, joinPayload, nextEvent, sleep } from './helpers.js';

const RECT = { x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: '#000000', fillColor: 'transparent', strokeWidth: 1, strokeStyle: 'solid', opacity: 1 };
const addOp = () => ({ opId: randomUUID(), type: 'add', element: { id: randomUUID(), type: 'rect', data: RECT } });

async function startNode() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await setupApp(app);
  await app.listen(0);
  return app;
}

describe('Chia sẻ bảng: link, thành viên, lời mời (e2e)', () => {
  let app: INestApplication; // node A: nhận REST
  let nodeB: INestApplication; // node B: socket của người bị đá nằm ở đây -> chứng minh đá được qua Redis
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
  const join = (c: Socket, boardId: string, shareToken?: string) => c.emitWithAck('JoinBoard', { ...joinPayload(boardId), shareToken });
  const kicked = (c: Socket) => Promise.all([nextEvent(c, 'AccessChanged'), nextEvent(c, 'disconnect')]);

  beforeAll(async () => {
    [app, nodeB] = await Promise.all([startNode(), startNode()]);
    prisma = app.get(PrismaService);
  });

  afterEach(() => {
    clients.splice(0).forEach((c) => c.disconnect());
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    const redis = app.get<RedisClient>(REDIS);
    const keys = await redis.keys('rl:*');
    if (keys.length) await redis.del(keys);
  });

  afterAll(async () => {
    await Promise.all([app.close(), nodeB.close()]);
  });

  describe('JoinBoard: ai được vào', () => {
    it('người lạ -> not_found (giống hệt bảng không tồn tại); thành viên -> vai trò của mình', async () => {
      const [owner, member, stranger] = [await createUser(app), await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id, [member.id]);
      await expect(join(await open(stranger.token), board.id)).resolves.toEqual({ ok: false, reason: 'not_found' });
      await expect(join(await open(member.token), board.id)).resolves.toEqual({ ok: true, role: 'EDITOR' });
    });

    it('bảng không chủ (seed demo) -> ai cũng vào được với EDITOR', async () => {
      const board = await prisma.board.create({ data: {} });
      await expect(join(await open((await createUser(app)).token), board.id)).resolves.toEqual({ ok: true, role: 'EDITOR' });
    });

    it('link VIEWER: người lạ vào được với VIEWER, SubmitOps bị forbidden; token sai / của bảng khác / hết hạn / đã thu hồi -> not_found', async () => {
      const [owner, stranger] = [await createUser(app), await createUser(app)];
      const [board, other] = [await createBoard(app, owner.id), await createBoard(app, owner.id)];
      const { body: link } = await api(owner.token).post(`/boards/${board.id}/share-links`, { role: 'VIEWER' }).expect(201);

      const c = await open(stranger.token);
      await expect(join(c, board.id, link.token)).resolves.toEqual({ ok: true, role: 'VIEWER' });
      await expect(c.emitWithAck('SubmitOps', { ops: [addOp()] })).resolves.toEqual({ ok: false, reason: 'forbidden' });

      const expired = await prisma.shareLink.create({ data: { boardId: board.id, token: randomUUID(), role: 'EDITOR', createdBy: owner.id, expiresAt: new Date(Date.now() - 1000) } });
      const revoked = await prisma.shareLink.create({ data: { boardId: board.id, token: randomUUID(), role: 'EDITOR', createdBy: owner.id, revokedAt: new Date() } });
      for (const [boardId, token] of [[board.id, 'wrong'], [other.id, link.token], [board.id, expired.token], [board.id, revoked.token]] as const) {
        await expect(join(await open(stranger.token), boardId, token)).resolves.toEqual({ ok: false, reason: 'not_found' });
      }
    });

    it('thành viên VIEWER cầm link EDITOR -> vẫn VIEWER (chủ bảng đã chọn vai trò riêng cho người này)', async () => {
      const [owner, viewer] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id);
      await prisma.boardMember.create({ data: { boardId: board.id, userId: viewer.id, role: 'VIEWER' } });
      const { body: link } = await api(owner.token).post(`/boards/${board.id}/share-links`, { role: 'EDITOR' }).expect(201);
      await expect(join(await open(viewer.token), board.id, link.token)).resolves.toEqual({ ok: true, role: 'VIEWER' });
    });
  });

  describe('link chia sẻ (REST)', () => {
    it('chủ tạo + xem danh sách; EDITOR -> 403; người lạ -> 404; role OWNER / khóa lạ / id sai -> 400', async () => {
      const [owner, editor, stranger] = [await createUser(app), await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id, [editor.id]);
      const path = `/boards/${board.id}/share-links`;

      const { body: link } = await api(owner.token).post(path, { role: 'EDITOR', expiresInHours: 24 }).expect(201);
      expect(link).toEqual({ id: expect.any(String), token: expect.stringMatching(/^[\w-]{43}$/), role: 'EDITOR', expiresAt: expect.any(String), createdAt: expect.any(String) });
      expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      await expect(api(owner.token).get(path).expect(200)).resolves.toMatchObject({ body: [link] });

      expect(codeOf(await api(editor.token).post(path, { role: 'VIEWER' }).expect(403))).toBe('BOARD_FORBIDDEN');
      expect(codeOf(await api(stranger.token).get(path).expect(404))).toBe('BOARD_NOT_FOUND');
      await api(owner.token).post(path, { role: 'OWNER' }).expect(400);
      await api(owner.token).post(path, { role: 'VIEWER', boardId: randomUUID() }).expect(400);
      await api(owner.token).get('/boards/not-a-uuid/share-links').expect(400);
    });

    it('thu hồi: người vào bằng link (ở node B) nhận AccessChanged rồi bị ngắt, vào lại -> not_found; chủ bảng không bị đá; thu hồi lần 2 -> 404', async () => {
      const [owner, guest] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id);
      const { body: link } = await api(owner.token).post(`/boards/${board.id}/share-links`, { role: 'EDITOR' }).expect(201);
      const o = await open(owner.token);
      await join(o, board.id);
      const g = await open(guest.token, nodeB);
      await join(g, board.id, link.token);

      const gone = kicked(g);
      let ownerKicked = false;
      o.on('AccessChanged', () => (ownerKicked = true));
      await api(owner.token).delete(`/boards/${board.id}/share-links/${link.id}`).expect(204);
      await expect(gone).resolves.toEqual([{ reason: 'link_revoked' }, 'io server disconnect']);

      await expect(join(await open(guest.token), board.id, link.token)).resolves.toEqual({ ok: false, reason: 'not_found' });
      await expect(api(owner.token).get(`/boards/${board.id}/share-links`).expect(200)).resolves.toMatchObject({ body: [] });
      expect(codeOf(await api(owner.token).delete(`/boards/${board.id}/share-links/${link.id}`).expect(404))).toBe('SHARE_LINK_NOT_FOUND');
      await sleep(50);
      expect(ownerKicked).toBe(false);
      expect(o.connected).toBe(true);
    });
  });

  describe('thành viên (REST)', () => {
    it('danh sách: chủ + thành viên kèm email/tên; không lộ passwordHash', async () => {
      const [owner, editor] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id, [editor.id]);
      const { body } = await api(owner.token).get(`/boards/${board.id}/members`).expect(200);
      expect(body).toEqual([
        { userId: owner.id, email: owner.email, displayName: 'E2E', avatarUrl: null, role: 'OWNER' },
        { userId: editor.id, email: editor.email, displayName: 'E2E', avatarUrl: null, role: 'EDITOR' },
      ]);
    });

    it('đổi EDITOR -> VIEWER: socket của người đó (node B) bị đá "role_changed", vào lại thành VIEWER; tab của họ ở BẢNG KHÁC không bị đá', async () => {
      const [owner, member] = [await createUser(app), await createUser(app)];
      const [board, otherBoard] = [await createBoard(app, owner.id, [member.id]), await createBoard(app, owner.id, [member.id])];
      const m = await open(member.token, nodeB);
      await join(m, board.id);
      const elsewhere = await open(member.token, nodeB);
      await join(elsewhere, otherBoard.id);

      const gone = kicked(m);
      const res = await api(owner.token).patch(`/boards/${board.id}/members/${member.id}`, { role: 'VIEWER' }).expect(200);
      expect(res.body).toEqual({ userId: member.id, role: 'VIEWER' });
      await expect(gone).resolves.toEqual([{ reason: 'role_changed' }, 'io server disconnect']);

      const again = await open(member.token);
      await expect(join(again, board.id)).resolves.toEqual({ ok: true, role: 'VIEWER' });
      await expect(again.emitWithAck('SubmitOps', { ops: [addOp()] })).resolves.toEqual({ ok: false, reason: 'forbidden' });
      expect(elsewhere.connected).toBe(true);
    });

    it('đổi vai trò chủ bảng / người ngoài / role OWNER -> 400, 404, 400', async () => {
      const [owner, member] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id, [member.id]);
      const path = (id: string) => `/boards/${board.id}/members/${id}`;
      expect(codeOf(await api(owner.token).patch(path(owner.id), { role: 'VIEWER' }).expect(400))).toBe('OWNER_ROLE_FIXED');
      expect(codeOf(await api(owner.token).patch(path(randomUUID()), { role: 'VIEWER' }).expect(404))).toBe('MEMBER_NOT_FOUND');
      await api(owner.token).patch(path(member.id), { role: 'OWNER' }).expect(400);
      expect(codeOf(await api(member.token).patch(path(member.id), { role: 'EDITOR' }).expect(403))).toBe('BOARD_FORBIDDEN');
    });

    it('xóa thành viên: bị đá "removed", vào lại -> not_found; xóa chủ bảng -> 400', async () => {
      const [owner, member] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id, [member.id]);
      const m = await open(member.token, nodeB);
      await join(m, board.id);

      const gone = kicked(m);
      await api(owner.token).delete(`/boards/${board.id}/members/${member.id}`).expect(204);
      await expect(gone).resolves.toEqual([{ reason: 'removed' }, 'io server disconnect']);
      await expect(join(await open(member.token), board.id)).resolves.toEqual({ ok: false, reason: 'not_found' });
      expect(codeOf(await api(owner.token).delete(`/boards/${board.id}/members/${owner.id}`).expect(400))).toBe('OWNER_ROLE_FIXED');
    });
  });

  describe('lời mời qua email', () => {
    // Bắt link trong mail (listener chạy async sau khi response trả về)
    const inviteAndCatchToken = async (ownerToken: string, boardId: string, email: string, role = 'EDITOR') => {
      const send = vi.spyOn(app.get(MailService), 'send');
      const res = await api(ownerToken).post(`/boards/${boardId}/invitations`, { email, role }).expect(201);
      await vi.waitFor(() => expect(send).toHaveBeenCalled());
      const link = send.mock.calls[0]![2];
      return { invitation: res.body, token: new URL(link).searchParams.get('token')!, send };
    };

    it('mời (email viết hoa + dấu cách vẫn khớp) -> mail có link; DB chỉ lưu hash; chấp nhận -> thành viên, JoinBoard được; chấp nhận lần 2 -> 400', async () => {
      const [owner, invitee] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id);
      const { invitation, token, send } = await inviteAndCatchToken(owner.token, board.id, `  ${invitee.email.toUpperCase()} `);

      expect(invitation).toEqual({ id: expect.any(String), email: invitee.email, role: 'EDITOR', expiresAt: expect.any(String), createdAt: expect.any(String) });
      expect(send).toHaveBeenCalledWith(invitee.email, expect.stringContaining('mời bạn vào bảng'), expect.stringContaining('/invitations/accept?token='));
      const row = await prisma.boardInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
      expect(row.tokenHash).toBe(sha256(token));
      await expect(api(owner.token).get(`/boards/${board.id}/invitations`).expect(200)).resolves.toMatchObject({ body: [invitation] });

      await expect(api(invitee.token).post('/invitations/accept', { token }).expect(200)).resolves.toMatchObject({ body: { boardId: board.id, role: 'EDITOR' } });
      await expect(join(await open(invitee.token), board.id)).resolves.toEqual({ ok: true, role: 'EDITOR' });
      await expect(api(owner.token).get(`/boards/${board.id}/invitations`).expect(200)).resolves.toMatchObject({ body: [] });
      expect(codeOf(await api(invitee.token).post('/invitations/accept', { token }).expect(400))).toBe('INVALID_INVITATION');
    });

    it('người khác cầm link (sai email) -> 403; lời mời đã thu hồi / hết hạn -> 400', async () => {
      const [owner, invitee, other] = [await createUser(app), await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id);
      const { invitation, token } = await inviteAndCatchToken(owner.token, board.id, invitee.email);
      expect(codeOf(await api(other.token).post('/invitations/accept', { token }).expect(403))).toBe('INVITATION_EMAIL_MISMATCH');

      await api(owner.token).delete(`/boards/${board.id}/invitations/${invitation.id}`).expect(204);
      expect(codeOf(await api(invitee.token).post('/invitations/accept', { token }).expect(400))).toBe('INVALID_INVITATION');
      expect(codeOf(await api(owner.token).delete(`/boards/${board.id}/invitations/${invitation.id}`).expect(404))).toBe('INVITATION_NOT_FOUND');

      vi.restoreAllMocks();
      const second = await inviteAndCatchToken(owner.token, board.id, invitee.email);
      await prisma.boardInvitation.update({ where: { id: second.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(codeOf(await api(invitee.token).post('/invitations/accept', { token: second.token }).expect(400))).toBe('INVALID_INVITATION');
    });

    it('chủ bảng tự mời chính mình với VIEWER rồi chấp nhận -> vẫn OWNER (không tự hạ quyền); EDITOR không mời được', async () => {
      const [owner, editor] = [await createUser(app), await createUser(app)];
      const board = await createBoard(app, owner.id, [editor.id]);
      const { token } = await inviteAndCatchToken(owner.token, board.id, owner.email, 'VIEWER');
      await expect(api(owner.token).post('/invitations/accept', { token }).expect(200)).resolves.toMatchObject({ body: { role: 'OWNER' } });
      expect(codeOf(await api(editor.token).post(`/boards/${board.id}/invitations`, { email: 'x@e2e.test', role: 'VIEWER' }).expect(403))).toBe('BOARD_FORBIDDEN');
    });
  });
});
