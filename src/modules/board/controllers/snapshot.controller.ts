import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/types/auth.types.js';
import { SnapshotService } from '../services/snapshot.service.js';

const uuid = { schema: z.uuid() };

// Lịch sử phiên bản (6.5). Xem: mọi thành viên; khôi phục: EDITOR trở lên (8.1). Service kiểm.
@Controller('boards/:boardId/snapshots')
export class SnapshotController {
  constructor(private readonly snapshots: SnapshotService) {}

  @Get()
  list(@Param('boardId', uuid) boardId: string, @CurrentUser() user: AuthUser) {
    return this.snapshots.list(boardId, user.id);
  }

  @Get(':snapshotId')
  get(@Param('boardId', uuid) boardId: string, @Param('snapshotId', uuid) snapshotId: string, @CurrentUser() user: AuthUser) {
    return this.snapshots.get(boardId, user.id, snapshotId);
  }

  @Post(':snapshotId/restore')
  @HttpCode(200)
  restore(@Param('boardId', uuid) boardId: string, @Param('snapshotId', uuid) snapshotId: string, @CurrentUser() user: AuthUser) {
    return this.snapshots.restore(boardId, user.id, snapshotId);
  }
}
