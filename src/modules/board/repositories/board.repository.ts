import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng boards.
@Injectable()
export class BoardRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Tạo bảng + người tạo là OWNER trong board_members, cùng MỘT câu (nested write = Prisma tự gói transaction).
  create(ownerId: string, title: string | undefined) {
    return this.prisma.board.create({
      data: { title, ownerId, members: { create: { userId: ownerId, role: 'OWNER' } } },
      select: { id: true, title: true, createdAt: true },
    });
  }

  // Bảng còn sống + dòng thành viên của user này (nếu có). null = không có bảng.
  findWithMember(boardId: string, userId: string) {
    return this.prisma.board.findFirst({
      where: { id: boardId, deletedAt: null },
      select: { title: true, ownerId: true, members: { where: { userId }, select: { role: true } } },
    });
  }

  async findLastSeq(boardId: string, db: Db) {
    const board = await db.board.findFirst({ where: { id: boardId, deletedAt: null }, select: { lastSeq: true } });
    return board?.lastSeq ?? null;
  }

  // FOR UPDATE: khóa dòng này tới hết transaction -> node khác xử lý cùng bảng phải chờ -> seq không trùng.
  // Trả null = không có bảng (hoặc đã xóa mềm).
  async lockForUpdate(boardId: string, db: Db) {
    const rows = await db.$queryRaw<{ last_seq: number }[]>`
      SELECT last_seq FROM boards WHERE id = ${boardId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    return rows[0]?.last_seq ?? null;
  }

  setLastSeq(boardId: string, lastSeq: number, db: Db) {
    return db.board.update({ where: { id: boardId }, data: { lastSeq } });
  }
}
