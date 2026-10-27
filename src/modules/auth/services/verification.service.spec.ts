import type { VerificationTokenRepository } from '../repositories/verification-token.repository.js';
import { sha256 } from '../utils/token.util.js';
import { VerificationService } from './verification.service.js';

describe('VerificationService', () => {
  const repo = { create: vi.fn() };
  const service = new VerificationService(repo as unknown as VerificationTokenRepository);

  it('issue: DB lưu sha256 + type + hạn, chạy trong transaction được truyền vào', async () => {
    const tx = {} as never;
    const token = await service.issue('u1', 'EMAIL_VERIFY', 60_000, tx);
    const [saved, db] = repo.create.mock.calls[0]!;
    expect(saved).toMatchObject({ userId: 'u1', type: 'EMAIL_VERIFY', tokenHash: sha256(token) });
    expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(db).toBe(tx);
  });
});
