import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

// Facade để module khác (comment, snapshot, sharing...) phát tin mà không import gateway (tránh vòng phụ thuộc).
// Server đi qua Redis adapter nên mọi lệnh ở đây tới được client trên mọi node.
// Không dùng @socket.io/redis-emitter: thư viện đó không chạy với sharded adapter (đã thử, tin bị bỏ im lặng).
@Injectable()
export class SocketEmitter {
  private server?: Server;

  bind(server: Server) {
    this.server = server; // BoardGateway gọi trong afterInit
  }

  toBoard(boardId: string, event: string, data: unknown) {
    this.io().to(`board:${boardId}`).emit(event, data);
  }

  // 8.2: room = member:{boardId}:{userId} hoặc share:{linkId}
  kickFromBoard(room: string, reason: string) {
    const io = this.io();
    io.to(room).emit('AccessChanged', { reason }); // gửi trước để client biết vì sao bị ngắt
    io.in(room).disconnectSockets();
  }

  private io() {
    if (!this.server) throw new Error('SocketEmitter used before BoardGateway.afterInit bound the server');
    return this.server;
  }
}
