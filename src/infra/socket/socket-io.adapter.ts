import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { ServerOptions } from 'socket.io';

type RedisClient = ReturnType<typeof createClient>;

// - CORS phải đi qua adapter: decorator @WebSocketGateway đọc process.env trước khi .env được nạp.
// - Redis sharded adapter: emit tới room ở server nào cũng tới client ở mọi server.
//   "dynamic" = mỗi room một channel, server chỉ nhận tin của room nó đang có người (cần Redis >= 7).
export class SocketIoAdapter extends IoAdapter {
  private pub?: RedisClient;
  private sub?: RedisClient;

  constructor(
    app: INestApplicationContext,
    private readonly corsOrigin: string[],
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  async connectToRedis() {
    this.pub = createClient({ url: this.redisUrl });
    this.sub = this.pub.duplicate(); // kết nối subscribe không chạy được lệnh thường nên phải tách riêng
    await Promise.all([this.pub.connect(), this.sub.connect()]);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    if (!this.pub || !this.sub) throw new Error('Call connectToRedis() before useWebSocketAdapter()');
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigin },
      adapter: createShardedAdapter(this.pub, this.sub, { subscriptionMode: 'dynamic' }),
    } as ServerOptions);
  }

  override async dispose() {
    await super.dispose();
    await Promise.all([this.pub?.close(), this.sub?.close()]);
  }
}
