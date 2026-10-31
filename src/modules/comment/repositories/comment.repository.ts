import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Đủ để vẽ một bong bóng bình luận: không cần join thêm ở client
const FIELDS = {
  id: true,
  boardId: true,
  parentId: true,
  elementId: true,
  x: true,
  y: true,
  body: true,
  resolvedAt: true,
  createdAt: true,
  author: { select: { id: true, displayName: true, avatarUrl: true } },
} as const;

// Chỉ chứa query bảng comments.
@Injectable()
export class CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.CommentUncheckedCreateInput, db: Db) {
    return db.comment.create({ data, select: FIELDS });
  }

  // Lọc theo boardId: id comment của bảng khác coi như không có
  findInBoard(boardId: string, id: string) {
    return this.prisma.comment.findFirst({ where: { id, boardId }, select: { id: true, parentId: true, authorId: true } });
  }

  list(boardId: string, take: number) {
    return this.prisma.comment.findMany({ where: { boardId }, orderBy: { createdAt: 'asc' }, take, select: FIELDS });
  }

  update(id: string, data: Prisma.CommentUncheckedUpdateInput) {
    return this.prisma.comment.update({ where: { id }, data, select: FIELDS });
  }

  // Trả lời + thông báo của comment này xóa theo (onDelete: Cascade)
  delete(id: string) {
    return this.prisma.comment.delete({ where: { id } });
  }
}
