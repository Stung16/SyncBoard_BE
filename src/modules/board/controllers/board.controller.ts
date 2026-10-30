import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/types/auth.types.js';
import { createBoardSchema, type CreateBoardDto } from '../dto/create-board.dto.js';
import { BoardService } from '../services/board.service.js';

@Controller('boards')
export class BoardController {
  constructor(private readonly boards: BoardService) {}

  // Cần đăng nhập (JwtAuthGuard global, không @Public): người tạo thành OWNER.
  @Post()
  create(@Body({ schema: createBoardSchema }) { title }: CreateBoardDto, @CurrentUser() user: AuthUser) {
    return this.boards.create(user.id, title);
  }
}
