import type { ConfigService } from '@nestjs/config';
import type { SessionRepository } from '../repositories/session.repository.js';
import { sha256 } from '../../../common/utils/token.util.js';
import { SessionService } from './session.service.js';

describe('SessionService', () => {
  const tx = { tx: true };
  const repo = {
    create: vi.fn(async (..._args: any[]) => ({ id: 'new-id' })), // any: test đọc lại mọi field của data
    findByTokenHash: vi.fn(),
    revokeActive: vi.fn(async (): Promise<number> => 1),
    revokeFamily: vi.fn(),
    revokeByTokenHash: vi.fn(),
  };
  const config = { get: vi.fn(() => 30) }; // REFRESH_TTL_DAYS
  const prisma = { $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) };
  const service = new SessionService(
    repo as unknown as SessionRepository,
    config as unknown as ConfigService<never, true>,
    prisma as never,
  );
  const active = { id: 'old-id', userId: 'u1', familyId: 'f1', revokedAt: null, replacedById: null, expiresAt: new Date(Date.now() + 60_000) };

  beforeEach(() => vi.clearAllMocks());

  it('create: trả token gốc nhưng DB chỉ lưu sha256 của nó', async () => {
    const token = await service.create('u1', { ip: '1.2.3.4', userAgent: 'UA' });
    const saved = repo.create.mock.calls[0]![0];
    expect(token).toHaveLength(43);
    expect(saved.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(saved).toMatchObject({ userId: 'u1', ip: '1.2.3.4', userAgent: 'UA' });
  });

  it('create: mỗi lần đăng nhập một familyId mới; hạn = REFRESH_TTL_DAYS', async () => {
    await service.create('u1', {});
    await service.create('u1', {});
    const [a, b] = repo.create.mock.calls.map((c) => c[0]);
    expect(a.familyId).not.toBe(b.familyId);
    const days = (a.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThanOrEqual(30);
  });

  describe('rotate', () => {
    it('hợp lệ -> session mới CÙNG family trong transaction, thu hồi cũ trỏ sang mới, trả token mới', async () => {
      repo.findByTokenHash.mockResolvedValueOnce(active);
      const { userId, refreshToken } = await service.rotate('old-token', { ip: '1.2.3.4' });

      expect(repo.findByTokenHash).toHaveBeenCalledWith(sha256('old-token'));
      const [saved, db] = repo.create.mock.calls[0]!;
      expect(saved).toMatchObject({ userId: 'u1', familyId: 'f1', tokenHash: sha256(refreshToken), ip: '1.2.3.4' });
      expect(db).toBe(tx);
      expect(repo.revokeActive).toHaveBeenCalledWith('old-id', 'new-id', tx);
      expect(userId).toBe('u1');
      expect(refreshToken).not.toBe('old-token');
    });

    it.each([
      ['không tìm thấy', null],
      ['hết hạn', { ...active, expiresAt: new Date(Date.now() - 1) }],
      ['đã logout (thu hồi, không có replacedById)', { ...active, revokedAt: new Date(Date.now() - 60_000) }],
      ['vừa bị tab khác thay (< 10s)', { ...active, revokedAt: new Date(), replacedById: 'x' }],
    ])('%s -> INVALID_REFRESH_TOKEN, không tạo session, không giết family', async (_, row) => {
      repo.findByTokenHash.mockResolvedValueOnce(row);
      await expect(service.rotate('t', {})).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN', status: 401 });
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.revokeFamily).not.toHaveBeenCalled();
    });

    it('token đã bị thay từ lâu mà vẫn dùng (bị đánh cắp) -> thu hồi cả family NGOÀI transaction rồi mới ném', async () => {
      repo.findByTokenHash.mockResolvedValueOnce({ ...active, revokedAt: new Date(Date.now() - 60_000), replacedById: 'x' });
      await expect(service.rotate('t', {})).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
      expect(repo.revokeFamily).toHaveBeenCalledWith('f1');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('request khác thu hồi trước (count 0) -> ném lỗi để rollback session vừa tạo', async () => {
      repo.findByTokenHash.mockResolvedValueOnce(active);
      repo.revokeActive.mockResolvedValueOnce(0);
      await expect(service.rotate('t', {})).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    });
  });

  it('revoke: thu hồi theo sha256, không lưu/so token gốc', async () => {
    await service.revoke('raw');
    expect(repo.revokeByTokenHash).toHaveBeenCalledWith(sha256('raw'));
  });
});
