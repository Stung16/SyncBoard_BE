import type { VerificationTokenRepository } from '../repositories/verification-token.repository.js';
import { sha256 } from '../../../common/utils/token.util.js';
import { VerificationService } from './verification.service.js';

describe('VerificationService', () => {
  const repo = { create: vi.fn(), deleteUnused: vi.fn(), findByTokenHash: vi.fn(), markUsed: vi.fn() };

  beforeEach(() => vi.clearAllMocks());
  const service = new VerificationService(repo as unknown as VerificationTokenRepository);

  it('issue: DB lưu sha256 + type + hạn, chạy trong transaction được truyền vào', async () => {
    const tx = {} as never;
    const token = await service.issue('u1', 'EMAIL_VERIFY', 60_000, tx);
    const [saved, db] = repo.create.mock.calls[0]!;
    expect(saved).toMatchObject({ userId: 'u1', type: 'EMAIL_VERIFY', tokenHash: sha256(token) });
    expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(db).toBe(tx);
  });

  it('reissue: xóa token chưa dùng cùng loại TRƯỚC rồi mới phát token mới, cùng transaction', async () => {
    const tx = {} as never;
    const token = await service.reissue('u1', 'EMAIL_VERIFY', 60_000, tx);
    expect(repo.deleteUnused).toHaveBeenCalledWith('u1', 'EMAIL_VERIFY', tx);
    expect(repo.deleteUnused.mock.invocationCallOrder[0]).toBeLessThan(repo.create.mock.invocationCallOrder[0]!);
    expect(repo.create.mock.calls[0]![0].tokenHash).toBe(sha256(token));
    expect(repo.create.mock.calls[0]![1]).toBe(tx);
  });

  it('consume: mỗi loại token báo lỗi riêng; dùng token verify để reset mật khẩu bị từ chối', async () => {
    const verifyRow = { id: 't1', userId: 'u1', type: 'EMAIL_VERIFY', usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    repo.findByTokenHash.mockResolvedValueOnce(verifyRow);
    await expect(service.consume('x', 'PASSWORD_RESET')).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    repo.findByTokenHash.mockResolvedValueOnce(null);
    await expect(service.consume('x', 'EMAIL_VERIFY')).rejects.toMatchObject({ code: 'INVALID_VERIFY_TOKEN' });
    expect(repo.markUsed).not.toHaveBeenCalled();
  });
});
