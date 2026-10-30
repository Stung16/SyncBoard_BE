import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { AppliedOp } from '../domain/apply-op.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng operations (nhật ký op của từng bảng).
@Injectable()
export class OperationRepository {
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
}
