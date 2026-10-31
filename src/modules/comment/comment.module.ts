import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { UserModule } from '../user/user.module.js';
import { CommentController } from './controllers/comment.controller.js';
import { CommentRepository } from './repositories/comment.repository.js';
import { CommentService } from './services/comment.service.js';

@Module({
  imports: [BoardModule, NotificationModule, UserModule], // SharingService: quyền + lọc thành viên; tên tác giả cho thông báo
  controllers: [CommentController],
  providers: [CommentService, CommentRepository],
})
export class CommentModule {}
