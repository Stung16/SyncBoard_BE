import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import type { AppliedOp } from '../domain/apply-op.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng operations (nhật ký op của từng bảng).
@Injectable()
export class OperationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // opId nào trong danh sách đã được lưu rồi, kèm seq đã cấp
  findByOpIds(boardId: string, opIds: string[], db: Db) {
    return db.operation.findMany({ where: { boardId, opId: { in: opIds } }, select: { opId: true, seq: true } });
  }

  // payload = phần kết quả ({ element } hoặc { clearedIds }), để phát lại y hệt OpsApplied
  createMany(boardId: string, actor: string, applied: AppliedOp[], db: Db) {
    return db.operation.createMany({
      data: applied.map(({ opId, seq, type, ...result }) => ({
        boardId,
        seq,
        opId,
        type,
        actor,
        elementId: 'element' in result ? result.element.id : null,
        payload: result as Prisma.InputJsonValue,
      })),
    });
  }

  findAfter(boardId: string, seq: number, take: number, db: Db) {
    return db.operation.findMany({ where: { boardId, seq: { gt: seq } }, orderBy: { seq: 'asc' }, take });
  }

  findBySeq(boardId: string, seq: number, db: Db) {
    return db.operation.findUnique({ where: { boardId_seq: { boardId, seq } } });
  }

  // Op restore_snapshot: không phải AppliedOp (không phát lại được từng bước) -> ghi riêng
  createRestore(boardId: string, seq: number, actor: string, snapshotId: string, db: Db) {
    return db.operation.create({
      data: { boardId, seq, opId: randomUUID(), type: 'restore_snapshot', actor, payload: { snapshotId } },
    });
  }

  // Dọn op đã nằm trong một bản chụp VÀ cũ hơn `before` (6.6). Client nối lại bị hổng khúc -> getMissedOps tự trả BoardState.
  // Một câu SQL, chạy trùng trên nhiều node cũng vô hại.
  deleteCoveredBySnapshots(before: Date, db: Db = this.prisma) {
    return db.$executeRaw`
      DELETE FROM operations o
      USING (SELECT board_id, max(seq) AS seq FROM snapshots GROUP BY board_id) s
      WHERE o.board_id = s.board_id AND o.seq <= s.seq AND o.created_at < ${before}`;
  }
}
