import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/types/auth.types.js';
import { createCommentSchema, updateCommentSchema, type CreateCommentDto, type UpdateCommentDto } from '../dto/comment.dto.js';
import { CommentService } from '../services/comment.service.js';

const uuid = { schema: z.uuid() };

// REST để tạo/sửa/xóa, rồi service phát CommentAdded / CommentUpdated / CommentDeleted cho cả phòng (5.1).
@Controller('boards/:boardId/comments')
export class CommentController {
  constructor(private readonly comments: CommentService) {}

  @Get()
  list(@Param('boardId', uuid) boardId: string, @CurrentUser() user: AuthUser) {
    return this.comments.list(boardId, user.id);
  }

  @Post()
  create(@Param('boardId', uuid) boardId: string, @Body({ schema: createCommentSchema }) dto: CreateCommentDto, @CurrentUser() user: AuthUser) {
    return this.comments.create(boardId, user.id, dto);
  }

  @Patch(':commentId')
  update(
    @Param('boardId', uuid) boardId: string,
    @Param('commentId', uuid) commentId: string,
    @Body({ schema: updateCommentSchema }) dto: UpdateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.comments.update(boardId, user.id, commentId, dto);
  }

  @Delete(':commentId')
  @HttpCode(204)
  remove(@Param('boardId', uuid) boardId: string, @Param('commentId', uuid) commentId: string, @CurrentUser() user: AuthUser) {
    return this.comments.remove(boardId, user.id, commentId);
  }
}
