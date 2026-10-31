import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/types/auth.types.js';
import {
  auditLogQuerySchema,
  createBoardSchema,
  listBoardsSchema,
  renameBoardSchema,
  type AuditLogQueryDto,
  type CreateBoardDto,
  type ListBoardsDto,
  type RenameBoardDto,
} from '../dto/create-board.dto.js';
import { BoardService } from '../services/board.service.js';

const uuid = { schema: z.uuid() };

@Controller('boards')
export class BoardController {
  constructor(private readonly boards: BoardService) {}

  // Cần đăng nhập (JwtAuthGuard global, không @Public): người tạo thành OWNER.
  @Post()
  create(@Body({ schema: createBoardSchema }) { title }: CreateBoardDto, @CurrentUser() user: AuthUser) {
    return this.boards.create(user.id, title);
  }

  @Get()
  list(@Query({ schema: listBoardsSchema }) { search }: ListBoardsDto, @CurrentUser() user: AuthUser) {
    return this.boards.list(user.id, search);
  }

  @Get(':boardId')
  get(@Param('boardId', uuid) boardId: string, @CurrentUser() user: AuthUser) {
    return this.boards.get(boardId, user.id);
  }

  // Nhật ký: chỉ OWNER. ?before=<id dòng cuối trang trước> để xem trang sau.
  @Get(':boardId/audit-logs')
  auditLog(@Param('boardId', uuid) boardId: string, @Query({ schema: auditLogQuerySchema }) { before }: AuditLogQueryDto, @CurrentUser() user: AuthUser) {
    return this.boards.auditLog(boardId, user.id, before);
  }

  // Đổi tên, xóa: chỉ OWNER (8.1). Service kiểm.
  @Patch(':boardId')
  rename(@Param('boardId', uuid) boardId: string, @Body({ schema: renameBoardSchema }) { title }: RenameBoardDto, @CurrentUser() user: AuthUser) {
    return this.boards.rename(boardId, user.id, title);
  }

  @Delete(':boardId')
  @HttpCode(204)
  remove(@Param('boardId', uuid) boardId: string, @CurrentUser() user: AuthUser) {
    return this.boards.remove(boardId, user.id);
  }
}
