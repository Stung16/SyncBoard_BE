import type { ConfigService } from '@nestjs/config';
import type { SessionRepository } from '../repositories/session.repository.js';
import { sha256 } from '../utils/token.util.js';
import { SessionService } from './session.service.js';

describe('SessionService', () => {
  const repo = { create: vi.fn() };
  const config = { get: vi.fn(() => 30) }; // REFRESH_TTL_DAYS
  const service = new SessionService(repo as unknown as SessionRepository, config as unknown as ConfigService<never, true>);

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
});
