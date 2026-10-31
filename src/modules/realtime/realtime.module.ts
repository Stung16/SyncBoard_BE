import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module.js';
import { BoardGateway } from './board.gateway.js';

@Module({
  imports: [BoardModule], // BoardService: getState, submitOps; SharingService: resolveAccess
  providers: [BoardGateway],
})
export class RealtimeModule {}
