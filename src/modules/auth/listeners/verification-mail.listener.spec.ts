import { VerificationMailListener } from './verification-mail.listener.js';

describe('VerificationMailListener', () => {
  const mail = { send: vi.fn(async () => {}) };
  const config = { get: vi.fn(() => 'http://app.test') };
  const listener = new VerificationMailListener(mail as never, config as never);
  const event = { userId: 'u1', email: 'an@mail.com', displayName: 'An', verifyToken: 'verify-token' };

  beforeEach(() => vi.clearAllMocks());

  it('gửi link xác minh trỏ về frontend, kèm token', async () => {
    await listener.sendVerificationMail(event);
    expect(mail.send).toHaveBeenCalledWith('an@mail.com', expect.any(String), 'http://app.test/verify-email?token=verify-token');
  });

  it('gửi mail lỗi -> chỉ ghi log, không ném', async () => {
    mail.send.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(listener.sendVerificationMail(event)).resolves.toBeUndefined();
  });
});
