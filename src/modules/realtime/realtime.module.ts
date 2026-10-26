import { Module } from '@nestjs/common';
import { BoardGateway } from './board.gateway.js';

@Module({
  providers: [BoardGateway]
})
export class RealtimeModule {}
