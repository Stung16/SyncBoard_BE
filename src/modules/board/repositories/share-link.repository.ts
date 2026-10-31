import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

const FIELDS = { id: true, token: true, role: true, expiresAt: true, createdAt: true } as const;
// Còn dùng được: chưa thu hồi và (không hạn hoặc chưa tới hạn)
const usable = () => ({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });

// Chỉ chứa query bảng share_links.
@Injectable()
export class ShareLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.ShareLinkUncheckedCreateInput) {
    return this.prisma.shareLink.create({ data, select: FIELDS });
  }

  findUsable(boardId: string) {
    return this.prisma.shareLink.findMany({ where: { boardId, ...usable() }, orderBy: { createdAt: 'asc' }, select: FIELDS });
  }

  findUsableByToken(boardId: string, token: string) {
    return this.prisma.shareLink.findFirst({ where: { boardId, token, ...usable() }, select: { id: true, role: true } });
  }

  async revoke(boardId: string, id: string) {
    const { count } = await this.prisma.shareLink.updateMany({ where: { id, boardId, revokedAt: null }, data: { revokedAt: new Date() } });
    return count;
  }
}
