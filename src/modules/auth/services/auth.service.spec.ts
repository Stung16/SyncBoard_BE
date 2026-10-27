import { verify } from 'argon2';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuthService } from './auth.service.js';

describe('AuthService.register', () => {
  const tx = { tx: true };
  const deps = {
    prisma: { $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) },
    users: { create: vi.fn(async (d: { email: string; passwordHash: string }, _tx?: unknown) => ({ id: 'u1', email: d.email })) },
    sessions: { create: vi.fn(async () => 'refresh-token') },
    verification: { issue: vi.fn(async () => 'verify-token') },
    mail: { send: vi.fn(async () => {}) },
    jwt: { signAsync: vi.fn(async () => 'access-token') },
    config: { get: vi.fn(() => 'http://app.test') },
  };
  const service = new AuthService(
    deps.prisma as never, deps.users as never, deps.sessions as never, deps.verification as never,
    deps.mail as never, deps.jwt as never, deps.config as never,
  );
  const dto = { email: 'an@mail.com', password: 'secret-pass', displayName: 'An' };

  beforeEach(() => vi.clearAllMocks());

  it('băm mật khẩu bằng argon2 (không lưu bản rõ)', async () => {
    await service.register(dto, {});
    const { passwordHash } = deps.users.create.mock.calls[0]![0];
    expect(passwordHash).not.toBe(dto.password);
    expect(passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verify(passwordHash, dto.password)).toBe(true);
  });

  it('tạo user + token xác minh trong CÙNG transaction', async () => {
    await service.register(dto, {});
    expect(deps.users.create.mock.calls[0]![1]).toBe(tx);
    expect(deps.verification.issue).toHaveBeenCalledWith('u1', 'EMAIL_VERIFY', expect.any(Number), tx);
  });

  it('gửi link xác minh trỏ về frontend, kèm token', async () => {
    await service.register(dto, {});
    expect(deps.mail.send).toHaveBeenCalledWith('an@mail.com', expect.any(String), 'http://app.test/verify-email?token=verify-token');
  });

  it('email trùng (P2002) -> AppError EMAIL_TAKEN, field email; lỗi khác giữ nguyên', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
    deps.users.create.mockRejectedValueOnce(p2002);
    await expect(service.register(dto, {})).rejects.toMatchObject({ code: 'EMAIL_TAKEN', field: 'email', status: 409 });

    const other = new Error('db down');
    deps.users.create.mockRejectedValueOnce(other);
    await expect(service.register(dto, {})).rejects.toBe(other);
  });

  it('gửi mail lỗi vẫn đăng ký thành công', async () => {
    deps.mail.send.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(service.register(dto, {})).resolves.toMatchObject({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
