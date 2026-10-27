import type { UserRepository } from '../repositories/user.repository.js';
import { UserService } from './user.service.js';

describe('UserService', () => {
  const repo = { findByEmail: vi.fn(), create: vi.fn() };
  const service = new UserService(repo as unknown as UserRepository);

  beforeEach(() => vi.clearAllMocks());

  it('create chuẩn hóa email (trim + chữ thường) trước khi lưu', async () => {
    await service.create({ email: '  An@Mail.COM ', passwordHash: 'h', displayName: 'An' });
    expect(repo.create).toHaveBeenCalledWith({ email: 'an@mail.com', passwordHash: 'h', displayName: 'An' }, undefined);
  });

  it('findByEmail cũng chuẩn hóa -> tìm được dù người dùng gõ hoa', async () => {
    await service.findByEmail('AN@mail.com');
    expect(repo.findByEmail).toHaveBeenCalledWith('an@mail.com');
  });
});
