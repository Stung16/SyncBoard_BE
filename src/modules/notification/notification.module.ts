import { Module } from '@nestjs/common';
import { NotificationController } from './controllers/notification.controller.js';
import { NotificationRepository } from './repositories/notification.repository.js';
import { NotificationService } from './services/notification.service.js';

@Module({
  controllers: [NotificationController],
  providers: [NotificationService, NotificationRepository],
  exports: [NotificationService], // CommentModule tạo thông báo mention / trả lời
})
export class NotificationModule {}
