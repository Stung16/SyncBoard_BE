import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module.js';
import { BoardLocks } from './board-locks.js';
import { BoardController } from './controllers/board.controller.js';
import { SharingController } from './controllers/sharing.controller.js';
import { InvitationMailListener } from './listeners/invitation-mail.listener.js';
import { BoardRepository } from './repositories/board.repository.js';
import { ElementRepository } from './repositories/element.repository.js';
import { InvitationRepository } from './repositories/invitation.repository.js';
import { MemberRepository } from './repositories/member.repository.js';
import { OperationRepository } from './repositories/operation.repository.js';
import { ShareLinkRepository } from './repositories/share-link.repository.js';
import { BoardService } from './services/board.service.js';
import { SharingService } from './services/sharing.service.js';

@Module({
  imports: [UserModule], // SharingService: email + tên người mời / người chấp nhận
  controllers: [BoardController, SharingController],
  providers: [
    BoardService,
    SharingService,
    BoardLocks,
    BoardRepository,
    ElementRepository,
    OperationRepository,
    MemberRepository,
    ShareLinkRepository,
    InvitationRepository,
    InvitationMailListener, // @OnEvent chỉ chạy khi class là provider
  ],
  exports: [BoardService, SharingService], // RealtimeModule (gateway): submitOps, resolveAccess
})
export class BoardModule {}
