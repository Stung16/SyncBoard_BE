import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

// Chỉ chứa query bảng audit_logs. Chỉ ghi thêm và đọc, không sửa/xóa.
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AuditLogUncheckedCreateInput) {
    return this.prisma.auditLog.create({ data });
  }

  // Mới nhất trước. before = id dòng cuối của trang trước. Dùng id (UUIDv7, tăng theo thời gian) chứ không dùng createdAt:
  // hai dòng cùng mili-giây thì "createdAt < x" bỏ sót dòng; id là thứ tự toàn phần nên không sót, không lặp.
  listForBoard(boardId: string, before: string | undefined, take: number) {
    return this.prisma.auditLog.findMany({
      where: { boardId, ...(before && { id: { lt: before } }) },
      orderBy: { id: 'desc' },
      take,
      select: { id: true, actorId: true, action: true, metadata: true, ip: true, createdAt: true },
    });
  }
}
