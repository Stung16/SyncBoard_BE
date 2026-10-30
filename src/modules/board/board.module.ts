import { Module } from '@nestjs/common';
import { BoardLocks } from './board-locks.js';
import { BoardController } from './controllers/board.controller.js';
import { BoardRepository } from './repositories/board.repository.js';
import { ElementRepository } from './repositories/element.repository.js';
import { OperationRepository } from './repositories/operation.repository.js';
import { BoardService } from './services/board.service.js';

@Module({
  controllers: [BoardController],
  providers: [BoardService, BoardLocks, BoardRepository, ElementRepository, OperationRepository],
  exports: [BoardService], // bước 6: RealtimeModule (gateway) gọi submitOps
})
export class BoardModule {}
