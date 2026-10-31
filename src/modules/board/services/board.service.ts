import { Injectable } from '@nestjs/common';
import { generateKeyBetween } from 'fractional-indexing';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import type { Element, Operation, Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { SocketEmitter } from '../../../infra/socket/socket-emitter.service.js';
import { BoardLocks } from '../board-locks.js';
import { applyOp, type AppliedOp, type ElementState, type RejectReason } from '../domain/apply-op.js';
import { reorderZIndex, type ReorderPosition } from '../domain/z-index.js';
import type { ElementType } from '../dto/element.dto.js';
import type { OpDto } from '../dto/op.dto.js';
import { BoardRepository } from '../repositories/board.repository.js';
import { ElementRepository } from '../repositories/element.repository.js';
import { AssetRepository } from '../repositories/asset.repository.js';
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
    private readonly assets: AssetRepository,
    private readonly locks: BoardLocks,
    private readonly emitter: SocketEmitter,
  ) {}

  create(ownerId: string, title?: string) {
    return this.boards.create(ownerId, title);
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
      if (rows[0]?.seq !== sinceSeq + 1) return null; // thiếu khúc đầu (op cũ đã bị dọn) -> phát lại sẽ lệch
      if (rows.some((r) => r.type === 'restore_snapshot')) return null; // khôi phục phiên bản thay cả bảng, không phát lại từng bước được
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

            // Ảnh: assetId phải là asset của ĐÚNG bảng này (không cho dán ảnh bảng khác sang). Một query cho cả lô.
            const assetIds = [...new Set(fresh.map(assetIdOf).filter((a) => a !== undefined))];
            const knownAssets = new Set(assetIds.length ? await this.assets.findIdsOfBoard(boardId, assetIds, tx) : []);

            let top = await this.elements.maxZIndex(boardId, tx);
            const ctx = { actor, zIndexFor: () => (top = generateKeyBetween(top, null)) }; // mỗi add mới nằm trên cùng

            for (const op of fresh) {
              // Undo xóa sạch bảng: không gắn với một element -> service tự xử lý, không qua applyOp
              if (op.type === 'restore' && op.clearSeq !== undefined) {
                const restored = await this.undoClear(boardId, actor, op.clearSeq, tx);
                if (typeof restored === 'string') {
                  rejected.push({ opId: op.opId, reason: restored });
                  continue;
                }
                for (const e of restored) state.set(e.id, e);
                applied.push({ opId: op.opId, seq: nextSeq(), type: 'restore', clearSeq: op.clearSeq, elements: restored });
                continue;
              }

              const id = targetId(op);
              const current = id === undefined ? undefined : state.get(id);
              const assetId = assetIdOf(op);
              if (assetId !== undefined && !knownAssets.has(assetId)) {
                rejected.push({ opId: op.opId, reason: 'asset_not_found', current });
                continue;
              }
              // reorder: zIndex mới tính từ hàng xóm đọc TRONG tx (thấy cả op trước trong lô). Không hợp lệ thì để domain từ chối.
              const reorderTo =
                op.type === 'reorder' && current && !current.isDeleted && !current.locked
                  ? await this.reorderTarget(boardId, current.zIndex, op.position, tx)
                  : null;
              const r = applyOp(current, op, { ...ctx, reorderTo });
              if (!r.ok) {
                rejected.push({ opId: op.opId, reason: r.reason, current }); // kèm current để client sửa lại màn hình
                continue; // op hỏng KHÔNG chặn op khác trong lô
              }
              await (current ? this.elements.update(boardId, r.next, tx) : this.elements.create(boardId, r.next, tx));
              state.set(r.next.id, r.next); // op sau trong cùng lô thấy kết quả của op trước
              if (top === null || r.next.zIndex > top) top = r.next.zIndex; // reorder front giữa lô -> add sau vẫn nằm trên nó
              applied.push({ opId: op.opId, seq: nextSeq(), type: op.type as 'add' | 'update' | 'delete' | 'restore' | 'reorder', element: r.next });
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

  // null = không đổi (đã ở đầu đó). Xem domain/z-index.ts để biết near/far là gì.
  private async reorderTarget(boardId: string, z: string, position: ReorderPosition, tx: Prisma.TransactionClient) {
    const dir = position === 'front' || position === 'forward' ? 'up' : 'down';
    const near = await this.elements.nearestZIndex(boardId, z, dir, true, tx);
    if (near === null) return null;
    const far =
      position === 'front'
        ? await this.elements.maxZIndex(boardId, tx)
        : position === 'back'
          ? await this.elements.minZIndex(boardId, tx)
          : await this.elements.nearestZIndex(boardId, near, dir, false, tx);
    return reorderZIndex(position, { near, far });
  }

  // UC 1.7: đọc danh sách id trong payload của op clear (client không gửi danh sách: 50.000 id vượt giới hạn tin).
  private async undoClear(boardId: string, actor: string, clearSeq: number, tx: Prisma.TransactionClient): Promise<ElementState[] | RejectReason> {
    const row = await this.operations.findBySeq(boardId, clearSeq, tx);
    if (row?.type !== 'clear') return 'not_found'; // seq sai, không phải clear, hoặc op đã bị dọn (> 30 ngày)
    const { clearedIds } = row.payload as { clearedIds: string[] };
    const restored = (await this.elements.restoreMany(boardId, clearedIds, actor, tx)).map(toState);
    return restored.length > 0 ? restored : 'not_deleted'; // undo lần 2 -> không còn gì để bật lại
  }
}

// shortcut: chưa giới hạn 50.000 element/bảng (8.3) và chưa dọn operations cũ (GĐ4, sau khi có snapshot).

const targetId = (op: OpDto): string | undefined =>
  op.type === 'add' ? op.element.id : op.type === 'clear' ? undefined : op.elementId;

// assetId mà op muốn gắn vào element: add image, hoặc update đổi ảnh. Không phải UUID thì để domain từ chối (invalid_patch),
// đừng đưa vào query: cột uuid sẽ ném lỗi Prisma.
const assetIdOf = (op: OpDto): string | undefined => {
  const v = op.type === 'add' && op.element.type === 'image' ? op.element.data.assetId : op.type === 'update' ? op.patch['assetId'] : undefined;
  return typeof v === 'string' && z.uuid().safeParse(v).success ? v : undefined;
};

// Cùng opId xuất hiện 2 lần trong một lô (client lỗi) -> giữ cái đầu
const uniqueByOpId = (ops: OpDto[]) => {
  const seen = new Set<string>();
  return ops.filter((o) => !seen.has(o.opId) && seen.add(o.opId));
};

// Dòng DB -> ElementState. Dữ liệu trong DB do chính server ghi (đã qua kiểm tra) nên ép kiểu được.
export const toState = (r: Element): ElementState => ({
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
