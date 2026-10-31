import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';

// Mỗi bảng một hàng đợi: lô op của CÙNG bảng chạy lần lượt, bảng khác chạy song song.
// Chỉ là tối ưu trong một node; tính đúng khi nhiều node đến từ khóa dòng boards trong DB (SELECT ... FOR UPDATE).
@Injectable()
export class BoardLocks implements OnModuleDestroy {
  // boardId -> Promise của việc đang ở CUỐI hàng
  private readonly tails = new Map<string, Promise<unknown>>();
  private closing = false;

  async run<T>(boardId: string, work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new AppError('SHUTTING_DOWN'); // client gửi lại sau khi nối sang node khác (dedupe opId nên an toàn)
    const prev = this.tails.get(boardId) ?? Promise.resolve();
    // Chờ việc trước xong rồi mới chạy. .catch: việc trước lỗi cũng không được chặn việc sau.
    const next = prev.catch(() => {}).then(work);
    this.tails.set(boardId, next); // mình thành cuối hàng
    try {
      return await next;
    } finally {
      // Chỉ xóa khi mình vẫn là cuối hàng (không ai xếp sau) -> Map không phình mãi
      if (this.tails.get(boardId) === next) this.tails.delete(boardId);
    }
  }

  // Chỉ để test: kiểm Map đã được dọn
  size(): number {
    return this.tails.size;
  }

  // Chờ mọi việc đang chạy/đang xếp hàng xong
  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }

  // Graceful shutdown: đóng cửa rồi chờ lô đang chạy commit xong. Phải là onModuleDestroy, KHÔNG phải beforeApplicationShutdown:
  // Nest gọi onModuleDestroy của mọi module trước, PrismaModule (global) gọi sau cùng -> lúc này DB vẫn còn kết nối.
  // beforeApplicationShutdown chạy sau khi Prisma đã $disconnect -> lô đang chạy sẽ lỗi.
  async onModuleDestroy() {
    this.closing = true;
    await this.drain();
  }
}
