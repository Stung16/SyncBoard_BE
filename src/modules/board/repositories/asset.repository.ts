import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng assets (metadata; file nằm ở Storage).
@Injectable()
export class AssetRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AssetUncheckedCreateInput) {
    return this.prisma.asset.create({ data, select: { id: true, mimeType: true, sizeBytes: true } });
  }

  findById(id: string) {
    return this.prisma.asset.findUnique({ where: { id }, select: { boardId: true, storageKey: true, mimeType: true, sizeBytes: true } });
  }

  // id nào trong danh sách là asset của ĐÚNG bảng này (op image không được trỏ sang ảnh bảng khác)
  async findIdsOfBoard(boardId: string, ids: string[], db: Db) {
    const rows = await db.asset.findMany({ where: { boardId, id: { in: ids } }, select: { id: true } });
    return rows.map((r) => r.id);
  }
}
