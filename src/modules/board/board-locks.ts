import { Injectable } from '@nestjs/common';

// Mỗi bảng một hàng đợi: lô op của CÙNG bảng chạy lần lượt, bảng khác chạy song song.
// Chỉ là tối ưu trong một node; tính đúng khi nhiều node đến từ khóa dòng boards trong DB (UPDATE ... RETURNING).
@Injectable()
export class BoardLocks {
  // boardId -> Promise của việc đang ở CUỐI hàng
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(boardId: string, work: () => Promise<T>): Promise<T> {
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

  // Lúc tắt app (GĐ4 graceful shutdown): chờ mọi việc đang chạy xong
  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }
}
