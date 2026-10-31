import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { SocketEmitter } from '../../../infra/socket/socket-emitter.service.js';
import { NotificationRepository } from '../repositories/notification.repository.js';

type Created = Awaited<ReturnType<NotificationRepository['createMany']>>;

// shortcut: danh sách trả 50 thông báo mới nhất, chưa phân trang và chưa dọn thông báo cũ.
const LIST_LIMIT = 50;

@Injectable()
export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly emitter: SocketEmitter,
  ) {}

  // Gọi TRONG transaction của nghiệp vụ gây ra thông báo (comment...) -> không bao giờ có thông báo trỏ tới comment không tồn tại.
  create(rows: Prisma.NotificationCreateManyInput[], tx: Prisma.TransactionClient) {
    return rows.length ? this.notifications.createMany(rows, tx) : Promise.resolve([] as Created);
  }

  // Gọi SAU commit: người nhận đang online (tab nào cũng được, bảng nào cũng được) thấy ngay
  publish(created: Created) {
    for (const { userId, ...notification } of created) this.emitter.toUser(userId, 'NotificationCreated', notification);
  }

  async list(userId: string, unreadOnly: boolean) {
    const [items, unread] = await Promise.all([this.notifications.list(userId, unreadOnly, LIST_LIMIT), this.notifications.countUnread(userId)]);
    return { items, unread };
  }

  async markRead(userId: string, id: string) {
    await this.notifications.markRead(userId, id); // đã đọc rồi / không phải của mình -> không làm gì (idempotent)
  }

  async markAllRead(userId: string) {
    await this.notifications.markAllRead(userId);
  }
}
