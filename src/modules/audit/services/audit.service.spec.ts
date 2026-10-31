import { requestContext } from '../../../common/request-context.js';
import { AuditService } from './audit.service.js';

describe('AuditService.record', () => {
  const repo = { create: vi.fn(async () => ({})), listForBoard: vi.fn() };
  const service = new AuditService(repo as never);
  beforeEach(() => vi.clearAllMocks());

  it('lấy IP từ request đang chạy (AsyncLocalStorage), kể cả sau await', async () => {
    await requestContext.run({ ip: '203.0.113.7' }, async () => {
      await Promise.resolve();
      await service.record({ action: 'board.delete', actorId: 'u1', boardId: 'b1' });
    });
    expect(repo.create).toHaveBeenCalledWith({ action: 'board.delete', actorId: 'u1', boardId: 'b1', metadata: undefined, ip: '203.0.113.7' });
  });

  it('ngoài request (socket, job nền) -> ip undefined', async () => {
    await service.record({ action: 'board.clear', actorId: 'u1', boardId: 'b1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ ip: undefined }));
  });

  it('ghi log lỗi (DB chập) -> KHÔNG ném: hành động người dùng vừa làm không bị báo lỗi oan', async () => {
    repo.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.record({ action: 'auth.login', actorId: 'u1' })).resolves.toBeUndefined();
  });
});
