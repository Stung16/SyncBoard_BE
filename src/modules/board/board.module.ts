import { Module } from '@nestjs/common';
import { BoardController } from './board.controller.js';
import { BoardService } from './board.service.js';

@Module({
  controllers: [BoardController],
  providers: [BoardService]
})
export class BoardModule {}
