import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { currentIp } from '../../../common/request-context.js';
import { AuditRepository } from '../repositories/audit.repository.js';

// Danh sách hành động có ghi log. Thêm hành động mới = thêm một dòng ở đây (gõ sai tên là lỗi biên dịch).
export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.password_reset'
  | 'auth.session_reuse' // refresh token đã thu hồi bị dùng lại = nghi bị đánh cắp
  | 'board.create'
  | 'board.rename'
  | 'board.delete'
  | 'board.clear'
  | 'member.role_change'
  | 'member.remove'
  | 'share_link.create'
  | 'share_link.revoke'
  | 'invitation.create'
  | 'invitation.revoke'
  | 'invitation.accept'
  | 'snapshot.restore';

export type AuditEntry = {
  action: AuditAction;
  actorId: string | null; // null = hệ thống / chưa biết là ai (đăng nhập sai email)
  boardId?: string;
  metadata?: Prisma.InputJsonObject; // chi tiết để đọc lại: vai trò cũ/mới, email được mời... KHÔNG ghi mật khẩu, token
};

const PAGE_SIZE = 100;

// "Ai làm gì, lúc nào, từ đâu". Chỉ hành động hiếm và quan trọng (quyền, xóa, đăng nhập); KHÔNG ghi từng nét vẽ (đã có operations).
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly audit: AuditRepository) {}

  // Gọi SAU khi hành động đã thành công (đã commit). Ghi log lỗi KHÔNG được làm hỏng hành động người dùng vừa làm xong.
  // shortcut: ghi ngoài transaction của hành động -> DB lỗi đúng lúc đó thì thiếu một dòng log (chỉ có cảnh báo ở log app).
  //           Cần chắc chắn 100% (yêu cầu pháp lý) thì truyền tx vào và ghi trong cùng transaction.
  async record({ action, actorId, boardId, metadata }: AuditEntry) {
    try {
      await this.audit.create({ action, actorId, boardId, metadata, ip: currentIp() });
    } catch (e) {
      this.logger.error(`Audit "${action}" not written: ${String(e)}`);
    }
  }

  listForBoard(boardId: string, before?: string) {
    return this.audit.listForBoard(boardId, before, PAGE_SIZE);
  }
}
