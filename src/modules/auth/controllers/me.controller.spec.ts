import type { UserService } from '../../user/services/user.service.js';
import { MeController } from './me.controller.js';

describe('MeController', () => {
  it('trả hồ sơ đọc từ DB theo id trong token', async () => {
    const users = { getById: vi.fn(async (id: string) => ({ id, displayName: 'An' })) };
    const controller = new MeController(users as unknown as UserService);
    await expect(controller.me({ id: 'u1' })).resolves.toEqual({ id: 'u1', displayName: 'An' });
    expect(users.getById).toHaveBeenCalledWith('u1');
  });
});
