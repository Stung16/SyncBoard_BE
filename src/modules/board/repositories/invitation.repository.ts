import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

const FIELDS = { id: true, email: true, role: true, expiresAt: true, createdAt: true } as const;
const pending = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });

// Chỉ chứa query bảng board_invitations.
@Injectable()
export class InvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.BoardInvitationUncheckedCreateInput) {
    return this.prisma.boardInvitation.create({ data, select: FIELDS });
  }

  findPending(boardId: string) {
    return this.prisma.boardInvitation.findMany({ where: { boardId, ...pending() }, orderBy: { createdAt: 'asc' }, select: FIELDS });
  }

  findPendingByHash(tokenHash: string) {
    return this.prisma.boardInvitation.findFirst({
      where: { tokenHash, ...pending(), board: { deletedAt: null } },
      select: { id: true, boardId: true, email: true, role: true },
    });
  }

  async revoke(boardId: string, id: string) {
    const { count } = await this.prisma.boardInvitation.updateMany({
      where: { id, boardId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  // Có điều kiện trong WHERE: 2 request chấp nhận cùng lúc thì chỉ một cái được count = 1
  async markAccepted(id: string, db: Db) {
    const { count } = await db.boardInvitation.updateMany({ where: { id, ...pending() }, data: { acceptedAt: new Date() } });
    return count;
  }
}
