import { verify } from 'argon2';
import { Prisma } from '../../../generated/prisma/client.js';
import { EMAIL_VERIFICATION_REQUESTED } from '../events/email-verification-requested.event.js';
import { PASSWORD_RESET_REQUESTED } from '../events/password-reset-requested.event.js';
import { USER_REGISTERED } from '../events/user-registered.event.js';
import { AuthService } from './auth.service.js';

describe('AuthService.register', () => {
  const tx = { tx: true };
  const deps = {
    prisma: { $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) },
    users: {
      create: vi.fn(async (d: { email: string; passwordHash: string; displayName: string }, _tx?: unknown) => ({
        id: 'u1',
        email: d.email,
        displayName: d.displayName,
      })),
    },
    sessions: { create: vi.fn(async () => 'refresh-token') },
    verification: { issue: vi.fn(async () => 'verify-token') },
    events: { emit: vi.fn() },
    jwt: { signAsync: vi.fn(async () => 'access-token') },
  };
  const service = new AuthService(
    deps.prisma as never, deps.users as never, deps.sessions as never, deps.verification as never,
    deps.events as never, deps.jwt as never, {} as never,
  );
  const dto = { email: 'an@mail.com', password: 'secret-pass', displayName: 'An' };

  beforeEach(() => vi.clearAllMocks());

  it('băm mật khẩu bằng argon2 (không lưu bản rõ)', async () => {
    await service.register(dto);
    const { passwordHash } = deps.users.create.mock.calls[0]![0];
    expect(passwordHash).not.toBe(dto.password);
    expect(passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verify(passwordHash, dto.password)).toBe(true);
  });

  it('tạo user + token xác minh trong CÙNG transaction', async () => {
    await service.register(dto);
    expect(deps.users.create.mock.calls[0]![1]).toBe(tx);
    expect(deps.verification.issue).toHaveBeenCalledWith('u1', 'EMAIL_VERIFY', expect.any(Number), tx);
  });

  it('phát USER_REGISTERED kèm token gốc, SAU khi transaction xong', async () => {
    await service.register(dto);
    expect(deps.events.emit).toHaveBeenCalledWith(USER_REGISTERED, {
      userId: 'u1',
      email: 'an@mail.com',
      displayName: 'An',
      verifyToken: 'verify-token',
    });
    expect(deps.events.emit.mock.invocationCallOrder[0]).toBeGreaterThan(deps.prisma.$transaction.mock.invocationCallOrder[0]!);
  });

  it('email trùng (P2002) -> AppError EMAIL_TAKEN, field email, KHÔNG phát event; lỗi khác giữ nguyên', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
    deps.users.create.mockRejectedValueOnce(p2002);
    await expect(service.register(dto)).rejects.toMatchObject({ code: 'EMAIL_TAKEN', field: 'email', status: 409 });
    expect(deps.events.emit).not.toHaveBeenCalled();

    const other = new Error('db down');
    deps.users.create.mockRejectedValueOnce(other);
    await expect(service.register(dto)).rejects.toBe(other);
  });
});

describe('AuthService.resendVerification', () => {
  const tx = { tx: true };
  const pending = { id: 'u1', email: 'an@mail.com', displayName: 'An', deletedAt: null, emailVerifiedAt: null };
  const deps = {
    prisma: { $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) },
    users: { findByEmail: vi.fn(async (): Promise<object | null> => pending) },
    verification: { reissue: vi.fn(async () => 'new-token') },
    events: { emit: vi.fn() },
    redis: { set: vi.fn(async (): Promise<string | null> => 'OK') },
  };
  const service = new AuthService(
    deps.prisma as never, deps.users as never, {} as never, deps.verification as never,
    deps.events as never, {} as never, deps.redis as never,
  );

  beforeEach(() => vi.clearAllMocks());

  it('thay token cũ bằng token mới trong transaction, phát event SAU commit', async () => {
    await service.resendVerification('an@mail.com');
    expect(deps.verification.reissue).toHaveBeenCalledWith('u1', 'EMAIL_VERIFY', expect.any(Number), tx);
    expect(deps.events.emit).toHaveBeenCalledWith(EMAIL_VERIFICATION_REQUESTED, {
      userId: 'u1', email: 'an@mail.com', displayName: 'An', verifyToken: 'new-token',
    });
    expect(deps.redis.set).toHaveBeenCalledWith('resend-verify:u1', '1', {
      expiration: { type: 'EX', value: 60 }, condition: 'NX',
    });
  });

  it.each([
    ['không có user', null],
    ['đã verify', { ...pending, emailVerifiedAt: new Date() }],
    ['đã xóa mềm', { ...pending, deletedAt: new Date() }],
  ])('%s -> im lặng: không phát token, không gửi mail, không ném', async (_, user) => {
    deps.users.findByEmail.mockResolvedValueOnce(user);
    await expect(service.resendVerification('an@mail.com')).resolves.toBeUndefined();
    expect(deps.verification.reissue).not.toHaveBeenCalled();
    expect(deps.events.emit).not.toHaveBeenCalled();
  });

  it('đang trong 60s chờ (Redis NX trả null) -> im lặng, không phát token', async () => {
    deps.redis.set.mockResolvedValueOnce(null);
    await service.resendVerification('an@mail.com');
    expect(deps.verification.reissue).not.toHaveBeenCalled();
    expect(deps.events.emit).not.toHaveBeenCalled();
  });
});

describe('AuthService.forgotPassword / resetPassword', () => {
  const tx = { tx: true };
  const user = { id: 'u1', email: 'an@mail.com', displayName: 'An', deletedAt: null, emailVerifiedAt: new Date() };
  const deps = {
    prisma: { $transaction: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) },
    users: {
      findByEmail: vi.fn(async (): Promise<object | null> => user),
      setPassword: vi.fn(async (..._args: unknown[]): Promise<object> => user),
      markEmailVerified: vi.fn(),
    },
    sessions: { revokeAll: vi.fn() },
    verification: { reissue: vi.fn(async () => 'reset-token'), consume: vi.fn(async () => 'u1') },
    events: { emit: vi.fn() },
    redis: { set: vi.fn(async (): Promise<string | null> => 'OK') },
  };
  const service = new AuthService(
    deps.prisma as never, deps.users as never, deps.sessions as never, deps.verification as never,
    deps.events as never, {} as never, deps.redis as never,
  );

  beforeEach(() => vi.clearAllMocks());

  it('forgot: token PASSWORD_RESET hạn 1 giờ, thay token cũ, phát event SAU commit', async () => {
    await service.forgotPassword('an@mail.com');
    expect(deps.verification.reissue).toHaveBeenCalledWith('u1', 'PASSWORD_RESET', 60 * 60 * 1000, tx);
    expect(deps.events.emit).toHaveBeenCalledWith(PASSWORD_RESET_REQUESTED, {
      userId: 'u1', email: 'an@mail.com', displayName: 'An', resetToken: 'reset-token',
    });
    expect(deps.redis.set).toHaveBeenCalledWith('forgot-password:u1', '1', expect.anything());
  });

  it.each([
    ['không có user', null],
    ['đã xóa mềm', { ...user, deletedAt: new Date() }],
  ])('forgot: %s -> im lặng, không token, không mail', async (_, found) => {
    deps.users.findByEmail.mockResolvedValueOnce(found);
    await expect(service.forgotPassword('an@mail.com')).resolves.toBeUndefined();
    expect(deps.verification.reissue).not.toHaveBeenCalled();
    expect(deps.events.emit).not.toHaveBeenCalled();
  });

  it('forgot: đang trong 60s chờ (Redis NX trả null) -> im lặng', async () => {
    deps.redis.set.mockResolvedValueOnce(null);
    await service.forgotPassword('an@mail.com');
    expect(deps.verification.reissue).not.toHaveBeenCalled();
    expect(deps.events.emit).not.toHaveBeenCalled();
  });

  it('reset: dùng token PASSWORD_RESET, lưu hash argon2, thu hồi MỌI session, tất cả trong 1 transaction', async () => {
    await service.resetPassword('reset-token', 'new-password-1');
    expect(deps.verification.consume).toHaveBeenCalledWith('reset-token', 'PASSWORD_RESET', tx);
    const [id, passwordHash, db] = deps.users.setPassword.mock.calls[0]! as [string, string, unknown];
    expect([id, db]).toEqual(['u1', tx]);
    expect(await verify(passwordHash, 'new-password-1')).toBe(true);
    expect(deps.sessions.revokeAll).toHaveBeenCalledWith('u1', tx);
    expect(deps.users.markEmailVerified).not.toHaveBeenCalled(); // đã verify từ trước -> không ghi đè
  });

  it('reset: email chưa verify -> verify luôn (mở được link = sở hữu email)', async () => {
    deps.users.setPassword.mockResolvedValueOnce({ ...user, emailVerifiedAt: null });
    await service.resetPassword('reset-token', 'new-password-1');
    expect(deps.users.markEmailVerified).toHaveBeenCalledWith('u1', tx);
  });

  it('reset: tài khoản đã xóa (P2025) -> INVALID_RESET_TOKEN; lỗi khác giữ nguyên', async () => {
    deps.users.setPassword.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 't' }));
    await expect(service.resetPassword('t', 'new-password-1')).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN', status: 400 });
    const other = new Error('db down');
    deps.users.setPassword.mockRejectedValueOnce(other);
    await expect(service.resetPassword('t', 'new-password-1')).rejects.toBe(other);
  });
});
