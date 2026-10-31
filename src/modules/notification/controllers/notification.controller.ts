import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/types/auth.types.js';
import { listNotificationsSchema, type ListNotificationsDto } from '../dto/notification.dto.js';
import { NotificationService } from '../services/notification.service.js';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  list(@Query({ schema: listNotificationsSchema }) { unread }: ListNotificationsDto, @CurrentUser() user: AuthUser) {
    return this.notifications.list(user.id, unread === 'true');
  }

  // Đặt TRƯỚC ':id/read' cho dễ đọc; hai route khác số đoạn nên không đè nhau.
  @Post('read-all')
  @HttpCode(204)
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(204)
  markRead(@Param('id', { schema: z.uuid() }) id: string, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(user.id, id);
  }
}
