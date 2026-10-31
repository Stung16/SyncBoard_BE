import { Module } from '@nestjs/common';
import { StorageModule } from '../../infra/storage/storage.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { UserModule } from '../user/user.module.js';
import { BoardLocks } from './board-locks.js';
import { AssetController } from './controllers/asset.controller.js';
import { BoardController } from './controllers/board.controller.js';
import { SharingController } from './controllers/sharing.controller.js';
import { SnapshotController } from './controllers/snapshot.controller.js';
import { SnapshotScheduler } from './jobs/snapshot.scheduler.js';
import { InvitationMailListener } from './listeners/invitation-mail.listener.js';
import { AssetRepository } from './repositories/asset.repository.js';
import { BoardRepository } from './repositories/board.repository.js';
import { ElementRepository } from './repositories/element.repository.js';
import { InvitationRepository } from './repositories/invitation.repository.js';
import { MemberRepository } from './repositories/member.repository.js';
import { OperationRepository } from './repositories/operation.repository.js';
import { ShareLinkRepository } from './repositories/share-link.repository.js';
import { SnapshotRepository } from './repositories/snapshot.repository.js';
import { AssetService } from './services/asset.service.js';
import { BoardService } from './services/board.service.js';
import { SharingService } from './services/sharing.service.js';
import { SnapshotService } from './services/snapshot.service.js';

@Module({
  imports: [UserModule, StorageModule, AuditModule], // UserModule: email/tên cho lời mời; StorageModule: file ảnh
  controllers: [BoardController, SharingController, SnapshotController, AssetController],
  providers: [
    BoardService,
    SharingService,
    SnapshotService,
    AssetService,
    SnapshotScheduler, // @Interval/@Cron chỉ chạy khi class là provider
    BoardLocks,
    BoardRepository,
    ElementRepository,
    OperationRepository,
    MemberRepository,
    ShareLinkRepository,
    InvitationRepository,
    SnapshotRepository,
    AssetRepository,
    InvitationMailListener, // @OnEvent chỉ chạy khi class là provider
  ],
  exports: [BoardService, SharingService], // RealtimeModule (gateway): submitOps, resolveAccess
})
export class BoardModule {}
