import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

const FIELDS = { id: true, type: true, actorId: true, boardId: true, commentId: true, data: true, readAt: true, createdAt: true } as const;

// Chỉ chứa query bảng notifications.
@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Trả dòng vừa tạo (kèm userId) để phát realtime cho đúng người
  createMany(data: Prisma.NotificationCreateManyInput[], db: Db) {
    return db.notification.createManyAndReturn({ data, select: { ...FIELDS, userId: true } });
  }

  list(userId: string, unreadOnly: boolean, take: number) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly && { readAt: null }) },
      orderBy: { createdAt: 'desc' },
      take,
      select: FIELDS,
    });
  }

  countUnread(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  // userId trong WHERE: không đánh dấu được thông báo của người khác
  markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  }

  markAllRead(userId: string) {
    return this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  }
}
