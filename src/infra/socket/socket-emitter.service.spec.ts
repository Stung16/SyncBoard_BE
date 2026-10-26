import type { Server } from 'socket.io';
import { SocketEmitter } from './socket-emitter.service.js';

function fakeServer() {
  const emit = vi.fn();
  const disconnectSockets = vi.fn();
  const server = { to: vi.fn(() => ({ emit })), in: vi.fn(() => ({ disconnectSockets })) };
  return { server: server as unknown as Server, raw: server, emit, disconnectSockets };
}

describe('SocketEmitter', () => {
  it('ném lỗi nếu dùng trước khi gateway bind server', () => {
    expect(() => new SocketEmitter().toBoard('b1', 'X', {})).toThrow(/before BoardGateway/);
  });

  it('toBoard phát vào room board:{id}', () => {
    const f = fakeServer();
    const emitter = new SocketEmitter();
    emitter.bind(f.server);
    emitter.toBoard('b1', 'CommentAdded', { id: 'c1' });
    expect(f.raw.to).toHaveBeenCalledWith('board:b1');
    expect(f.emit).toHaveBeenCalledWith('CommentAdded', { id: 'c1' });
  });

  it('kickFromBoard gửi AccessChanged TRƯỚC rồi mới ngắt', () => {
    const f = fakeServer();
    const emitter = new SocketEmitter();
    emitter.bind(f.server);
    emitter.kickFromBoard('member:b1:u1', 'revoked');
    expect(f.emit).toHaveBeenCalledWith('AccessChanged', { reason: 'revoked' });
    expect(f.disconnectSockets).toHaveBeenCalledOnce();
    expect(f.emit.mock.invocationCallOrder[0]).toBeLessThan(f.disconnectSockets.mock.invocationCallOrder[0]!);
  });
});
