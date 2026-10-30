import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { ElementState } from '../domain/apply-op.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng elements. Mọi hàm nhận `db` vì luôn chạy trong transaction của submitOps.
@Injectable()
export class ElementRepository {
  // Một query cho cả lô (không query từng element trong vòng lặp).
  findMany(boardId: string, ids: string[], db: Db) {
    return db.element.findMany({ where: { boardId, id: { in: ids } } });
  }

  // Element đang hiện, dưới lên trên. Cột z_index có COLLATE "C" nên ORDER BY của Prisma đã đúng thứ tự byte.
  findVisible(boardId: string, db: Db) {
    return db.element.findMany({ where: { boardId, isDeleted: false }, orderBy: { zIndex: 'asc' } });
  }

  // z-index lớn nhất của bảng (kể cả đã xóa mềm, để restore xong nó vẫn đúng vị trí cũ).
  // COLLATE "C" = so theo byte: "Zz" < "a0". Collation theo ngôn ngữ sẽ sắp sai thứ tự.
  async maxZIndex(boardId: string, db: Db) {
    const rows = await db.$queryRaw<{ z: string | null }[]>`
      SELECT max(z_index COLLATE "C") AS z FROM elements WHERE board_id = ${boardId}::uuid`;
    return rows[0]?.z ?? null;
  }

  create(boardId: string, el: ElementState, db: Db) {
    return db.element.create({ data: { boardId, ...columns(el) } });
  }

  // Khóa chính kép (board_id, id) -> Prisma đặt tên "boardId_id"
  update(boardId: string, el: ElementState, db: Db) {
    return db.element.update({ where: { boardId_id: { boardId, id: el.id } }, data: columns(el) });
  }

  // Op clear: xóa mềm mọi element chưa xóa và KHÔNG khóa (luật 2.12), trả id để báo client gỡ khỏi màn hình.
  clear(boardId: string, actor: string, db: Db) {
    return db.element.updateManyAndReturn({
      where: { boardId, isDeleted: false, locked: false },
      data: { isDeleted: true, version: { increment: 1 }, updatedBy: actor },
      select: { id: true },
    });
  }
}

// ElementState (domain) -> cột DB. data là JSON nên cần ép kiểu cho Prisma.
const columns = (el: ElementState) => ({
  id: el.id,
  type: el.type,
  data: el.data as Prisma.InputJsonValue,
  zIndex: el.zIndex,
  version: el.version,
  isDeleted: el.isDeleted,
  locked: el.locked,
  groupId: el.groupId,
  frameId: el.frameId,
  updatedBy: el.updatedBy,
});
