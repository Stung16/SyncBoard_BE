import { Global, Module } from '@nestjs/common';
import { SocketEmitter } from './socket-emitter.service.js';

// Module lá: không import module nào, nên ai inject SocketEmitter cũng không tạo vòng.
@Global()
@Module({
  providers: [SocketEmitter],
  exports: [SocketEmitter],
})
export class SocketEmitterModule {}
