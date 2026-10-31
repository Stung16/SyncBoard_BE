import { Module } from '@nestjs/common';
import { AuditRepository } from './repositories/audit.repository.js';
import { AuditService } from './services/audit.service.js';

// Module lá: không import module nghiệp vụ nào, nên auth/board/... import nó mà không tạo vòng.
// Route đọc log nằm ở module board (cần SharingService để kiểm quyền), không nằm ở đây.
@Module({
  providers: [AuditService, AuditRepository],
  exports: [AuditService],
})
export class AuditModule {}
