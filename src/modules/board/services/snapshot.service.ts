import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { SocketEmitter } from '../../../infra/socket/socket-emitter.service.js';
import { BoardLocks } from '../board-locks.js';
import type { ElementState } from '../domain/apply-op.js';
import { BoardRepository } from '../repositories/board.repository.js';
import { ElementRepository } from '../repositories/element.repository.js';
import { OperationRepository } from '../repositories/operation.repository.js';
import { SnapshotRepository } from '../repositories/snapshot.repository.js';
import { BoardService, toState } from './board.service.js';
import { SharingService } from './sharing.service.js';

// Định dạng nội dung một bản chụp; trùng định dạng export (7.2) để sau này dùng lại.
type SnapshotData = { formatVersion: 1; elements: ElementState[] };
// data của element là Record<string, unknown> -> Prisma không tự nhận là JSON, phải ép
const snapshotData = (elements: ElementState[]) => ({ formatVersion: 1, elements } satisfies SnapshotData) as unknown as Prisma.InputJsonValue;

// shortcut: chỉ trả 100 bản mới nhất, chưa phân trang và chưa dọn snapshot cũ (bảng hoạt động cả năm = ~100k bản). Cần thì thêm cursor.
const LIST_LIMIT = 100;
const OPS_RETENTION_MS = 30 * 24 * 3600_000;

@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService, // chỉ để mở transaction
    private readonly boards: BoardRepository,
    private readonly elements: ElementRepository,
    private readonly operations: OperationRepository,
    private readonly snapshots: SnapshotRepository,
    private readonly boardService: BoardService,
    private readonly sharing: SharingService,
    private readonly locks: BoardLocks,
    private readonly emitter: SocketEmitter,
  ) {}

  async list(boardId: string, userId: string) {
    await this.sharing.authorize(boardId, userId, 'view');
    return this.snapshots.list(boardId, LIST_LIMIT);
  }

  // Xem một bản: client vẽ ở chế độ chỉ đọc (6.5)
  async get(boardId: string, userId: string, snapshotId: string) {
    await this.sharing.authorize(boardId, userId, 'view');
    const snapshot = await this.snapshots.find(boardId, snapshotId);
    if (!snapshot) throw new AppError('SNAPSHOT_NOT_FOUND');
    return snapshot;
  }

  // Chụp bảng ở seq hiện tại. getState đọc RepeatableRead -> elements khớp đúng last_seq, không chặn người đang vẽ.
  // Trả 1 = đã chụp, 0 = seq này đã có bản (node khác chụp rồi).
  async capture(boardId: string) {
    const { lastSeq, elements } = await this.boardService.getState(boardId);
    return this.snapshots.createIfAbsent({ boardId, seq: lastSeq, data: snapshotData(elements) });
  }

  findChangedBoardIds() {
    return this.snapshots.findChangedBoardIds();
  }

  pruneOperations() {
    return this.operations.deleteCoveredBySnapshots(new Date(Date.now() - OPS_RETENTION_MS));
  }

  // 6.5: thay cả bảng bằng bản chụp. Trong BoardLocks + FOR UPDATE như submitOps: không op nào chen giữa.
  async restore(boardId: string, userId: string, snapshotId: string) {
    await this.sharing.authorize(boardId, userId, 'clearOrRestoreVersion');
    return this.locks.run(boardId, async () => {
      const seq = await this.prisma.$transaction(
        async (tx) => {
          const lastSeq = await this.boards.lockForUpdate(boardId, tx);
          if (lastSeq === null) throw new AppError('BOARD_NOT_FOUND');
          const target = await this.snapshots.find(boardId, snapshotId, tx);
          if (!target) throw new AppError('SNAPSHOT_NOT_FOUND');

          // Chụp trạng thái hiện tại TRƯỚC: lỡ khôi phục nhầm thì khôi phục lại bản này.
          // Đã có bản ở cùng seq (job vừa chụp) thì bỏ qua: nội dung y hệt, chỉ thiếu label.
          const current = (await this.elements.findVisible(boardId, tx)).map(toState);
          await this.snapshots.createIfAbsent({ boardId, seq: lastSeq, label: 'before-restore', data: snapshotData(current) }, tx);

          await this.elements.hideAll(boardId, userId, tx);
          // shortcut: mỗi element một câu upsert; 50.000 element sẽ chạm timeout 30s. Khi đó chia lô hoặc dùng một câu INSERT ... ON CONFLICT.
          for (const el of (target.data as unknown as SnapshotData).elements) await this.elements.restoreTo(boardId, el, userId, tx);

          const seq = lastSeq + 1;
          await this.operations.createRestore(boardId, seq, userId, snapshotId, tx); // getMissedOps thấy op này -> gửi BoardState
          await this.boards.setLastSeq(boardId, seq, tx);
          return seq;
        },
        { timeout: 30_000 },
      );
      // Phát sau commit, trong lock. Client nhận BoardReset -> JoinBoard lại KHÔNG kèm lastSeq để tải cả bảng.
      this.emitter.toBoard(boardId, 'BoardReset', { seq });
      return { seq };
    });
  }
}
