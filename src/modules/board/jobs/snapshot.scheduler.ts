import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { SnapshotService } from '../services/snapshot.service.js';

// Job chạy trên MỌI node (scheduler không biết có node khác). Cả hai job đều an toàn khi chạy trùng:
// chụp dùng ON CONFLICT (board_id, seq), dọn op là một câu DELETE.
@Injectable()
export class SnapshotScheduler {
  private readonly logger = new Logger(SnapshotScheduler.name);
  private running = false;

  constructor(private readonly snapshots: SnapshotService) {}

  // 6.6: mỗi 5 phút chụp những bảng có op mới. Trả số bản đã chụp; null = vòng trước chưa xong nên bỏ lượt này.
  @Interval('snapshot', 5 * 60_000)
  async captureChanged(): Promise<number | null> {
    if (this.running) return null; // @Interval không tự chống chạy chồng (chỉ @Cron có waitForCompletion)
    this.running = true;
    try {
      let made = 0;
      for (const boardId of await this.snapshots.findChangedBoardIds()) {
        try {
          made += await this.snapshots.capture(boardId);
        } catch (e) {
          this.logger.warn(`Snapshot board ${boardId} failed: ${String(e)}`); // một bảng lỗi không làm hỏng cả vòng
        }
      }
      return made;
    } finally {
      this.running = false;
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'prune-operations', waitForCompletion: true })
  async pruneOperations() {
    const deleted = await this.snapshots.pruneOperations();
    this.logger.log(`Pruned ${deleted} operations`);
    return deleted;
  }
}
