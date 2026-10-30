import { Injectable } from '@nestjs/common';
import { generateKeyBetween } from 'fractional-indexing';
import { AppError } from '../../../common/errors/app-error.js';
import type { Element, Operation } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { SocketEmitter } from '../../../infra/socket/socket-emitter.service.js';
import { BoardLocks } from '../board-locks.js';
import { applyOp, type AppliedOp, type ElementState, type RejectReason } from '../domain/apply-op.js';
import type { Role } from '../domain/permissions.js';
import type { ElementType } from '../dto/element.dto.js';
import type { OpDto } from '../dto/op.dto.js';
import { BoardRepository } from '../repositories/board.repository.js';
import { ElementRepository } from '../repositories/element.repository.js';
import { OperationRepository } from '../repositories/operation.repository.js';

export type RejectedOp = { opId: string; reason: RejectReason; current?: ElementState };
export type DuplicateOp = { opId: string; seq: number }; // op đã lưu từ lần gửi trước -> trả lại seq cũ

// Lỡ nhiều hơn số này thì gửi cả bảng: 1 lần tải nhanh hơn phát lại hàng nghìn op
const MISSED_OPS_LIMIT = 1000;

@Injectable()
export class BoardService {
  constructor(
    private readonly prisma: PrismaService, // chỉ để mở transaction; query nằm ở repository
    private readonly boards: BoardRepository,
    private readonly elements: ElementRepository,
    private readonly operations: OperationRepository,
    private readonly locks: BoardLocks,
    private readonly emitter: SocketEmitter,
  ) {}

  create(ownerId: string, title?: string) {
    return this.boards.create(ownerId, title);
  }

  // Vai trò của user trong bảng; null = không có bảng.
  async resolveRole(boardId: string, userId: string): Promise<Role | null> {
    const board = await this.boards.findWithMember(boardId, userId);
    if (!board) return null;
    // shortcut: chưa có chia sẻ (GĐ4) -> ai đăng nhập + biết id bảng đều vào với quyền EDITOR. Làm sharing thì trả null ở đây.
    return board.members[0]?.role ?? 'EDITOR';
  }

  // Ảnh chụp bảng cho người vừa vào. RepeatableRead: 2 câu đọc thấy CÙNG một thời điểm (last_seq khớp elements).
  getState(boardId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const lastSeq = await this.boards.findLastSeq(boardId, tx);
        if (lastSeq === null) throw new AppError('BOARD_NOT_FOUND');
        const elements = (await this.elements.findVisible(boardId, tx)).map(toState);
        return { lastSeq, elements };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  // Client nối lại, nói "tôi có tới seq N". Trả các op sau N; null = không phát lại được -> gửi cả bảng.
  getMissedOps(boardId: string, sinceSeq: number): Promise<AppliedOp[] | null> {
    return this.prisma.$transaction(async (tx) => {
      const lastSeq = await this.boards.findLastSeq(boardId, tx);
      if (lastSeq === null) throw new AppError('BOARD_NOT_FOUND');
      if (sinceSeq > lastSeq) return null; // client "đi trước" server (DB bị reset) -> tin bản của server
      if (sinceSeq === lastSeq) return []; // không lỡ gì

      const rows = await this.operations.findAfter(boardId, sinceSeq, MISSED_OPS_LIMIT + 1, tx);
      if (rows.length > MISSED_OPS_LIMIT) return null;
      if (rows[0]?.seq !== sinceSeq + 1) return null; // thiếu khúc đầu (op cũ đã bị dọn, GĐ4) -> phát lại sẽ lệch
      return rows.map(toApplied);
    });
  }

  // boardId + actor do gateway lấy từ client.data, KHÔNG BAO GIỜ từ payload. Quyền (can) gateway đã kiểm.
  async submitOps(boardId: string, actor: string, ops: OpDto[]) {
    return this.locks.run(boardId, async () => {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const lastSeq = await this.boards.lockForUpdate(boardId, tx);
          if (lastSeq === null) throw new AppError('BOARD_NOT_FOUND');

          // Chống gửi lại: client mất ack (rớt mạng) sẽ gửi lại cả lô -> op đã lưu thì trả seq cũ, KHÔNG áp lần 2.
          // Kiểm SAU khi khóa bảng: node khác lưu cùng opId thì đã commit xong trước khi mình có khóa -> chắc chắn thấy.
          const batch = uniqueByOpId(ops);
          const saved = new Map((await this.operations.findByOpIds(boardId, batch.map((o) => o.opId), tx)).map((o) => [o.opId, o.seq]));
          const duplicates: DuplicateOp[] = batch.filter((o) => saved.has(o.opId)).map((o) => ({ opId: o.opId, seq: saved.get(o.opId)! }));
          const fresh = batch.filter((o) => !saved.has(o.opId));

          const applied: AppliedOp[] = [];
          const rejected: RejectedOp[] = [];
          const nextSeq = () => lastSeq + applied.length + 1;

          // clear luôn đi một mình (schema đã ép) -> đường riêng, một câu updateMany
          const [first] = fresh;
          if (first?.type === 'clear') {
            const cleared = await this.elements.clear(boardId, actor, tx);
            applied.push({ opId: first.opId, seq: nextSeq(), type: 'clear', clearedIds: cleared.map((e) => e.id) });
          } else {
            // Đọc MỘT lần mọi element lô chạm tới, đọc TRONG tx (sau khi đã khóa bảng) -> không ai sửa xen vào
            const ids = [...new Set(fresh.map(targetId).filter((id) => id !== undefined))];
            const state = new Map((await this.elements.findMany(boardId, ids, tx)).map((r) => [r.id, toState(r)]));

            let top = await this.elements.maxZIndex(boardId, tx);
            const ctx = { actor, zIndexFor: () => (top = generateKeyBetween(top, null)) }; // mỗi add mới nằm trên cùng

            for (const op of fresh) {
              const id = targetId(op);
              const current = id === undefined ? undefined : state.get(id);
              const r = applyOp(current, op, ctx);
              if (!r.ok) {
                rejected.push({ opId: op.opId, reason: r.reason, current }); // kèm current để client sửa lại màn hình
                continue; // op hỏng KHÔNG chặn op khác trong lô
              }
              await (current ? this.elements.update(boardId, r.next, tx) : this.elements.create(boardId, r.next, tx));
              state.set(r.next.id, r.next); // op sau trong cùng lô thấy kết quả của op trước
              applied.push({ opId: op.opId, seq: nextSeq(), type: op.type as 'add' | 'update' | 'delete' | 'restore', element: r.next });
            }
          }

          if (applied.length > 0) {
            await this.operations.createMany(boardId, actor, applied, tx); // nhật ký: để chống gửi lại + phát lại MissedOps
            await this.boards.setLastSeq(boardId, lastSeq + applied.length, tx);
          }
          return { applied, rejected, duplicates };
        },
        { timeout: 10_000 }, // mặc định 5s; lô 100 op = 100 câu update, DB ở xa thì sát ngưỡng
      );

      // Phát SAU commit (lỗi DB thì không phát gì) và vẫn TRONG lock -> thứ tự phát = thứ tự seq
      if (result.applied.length > 0) this.emitter.toBoard(boardId, 'OpsApplied', result.applied);
      return result;
    });
  }
}

// shortcut: chưa giới hạn 50.000 element/bảng (8.3) và chưa dọn operations cũ (GĐ4, sau khi có snapshot).

const targetId = (op: OpDto): string | undefined =>
  op.type === 'add' ? op.element.id : op.type === 'clear' ? undefined : op.elementId;

// Cùng opId xuất hiện 2 lần trong một lô (client lỗi) -> giữ cái đầu
const uniqueByOpId = (ops: OpDto[]) => {
  const seen = new Set<string>();
  return ops.filter((o) => !seen.has(o.opId) && seen.add(o.opId));
};

// Dòng DB -> ElementState. Dữ liệu trong DB do chính server ghi (đã qua kiểm tra) nên ép kiểu được.
const toState = (r: Element): ElementState => ({
  id: r.id,
  type: r.type as ElementType,
  data: r.data as Record<string, unknown>,
  zIndex: r.zIndex,
  version: r.version,
  isDeleted: r.isDeleted,
  locked: r.locked,
  groupId: r.groupId,
  frameId: r.frameId,
  updatedBy: r.updatedBy,
});

// Dòng operations -> đúng dạng một phần tử của OpsApplied
const toApplied = (r: Operation) => ({ opId: r.opId, seq: r.seq, type: r.type, ...(r.payload as object) }) as AppliedOp;
