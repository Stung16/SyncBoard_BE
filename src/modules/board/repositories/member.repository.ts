import { Injectable } from '@nestjs/common';
import type { BoardRole, Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng board_members.
@Injectable()
export class MemberRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(boardId: string) {
    return this.prisma.boardMember.findMany({
      where: { boardId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, user: { select: { id: true, email: true, displayName: true, avatarUrl: true } } },
    });
  }

  async findUserIds(boardId: string, userIds: string[]) {
    const rows = await this.prisma.boardMember.findMany({ where: { boardId, userId: { in: userIds } }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  find(boardId: string, userId: string) {
    return this.prisma.boardMember.findUnique({ where: { boardId_userId: { boardId, userId } }, select: { role: true } });
  }

  updateRole(boardId: string, userId: string, role: BoardRole) {
    return this.prisma.boardMember.update({ where: { boardId_userId: { boardId, userId } }, data: { role }, select: { userId: true, role: true } });
  }

  delete(boardId: string, userId: string) {
    return this.prisma.boardMember.delete({ where: { boardId_userId: { boardId, userId } } });
  }

  // Đã là thành viên thì giữ nguyên vai trò cũ (không hạ OWNER thành VIEWER vì lỡ tự mời mình).
  addIfMissing(boardId: string, userId: string, role: BoardRole, db: Db) {
    return db.boardMember.upsert({
      where: { boardId_userId: { boardId, userId } },
      create: { boardId, userId, role },
      update: {},
      select: { role: true },
    });
  }
}
