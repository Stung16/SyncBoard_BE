import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

// Chỉ chứa query bảng sessions. Xoay vòng / phát hiện dùng lại là logic -> nằm ở SessionService.
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Trả cả dòng (có id): rotate cần id của session mới để ghi vào replacedById của session cũ.
  create(data: Prisma.SessionUncheckedCreateInput, db: Db = this.prisma) {
    return db.session.create({ data });
  }

  // token_hash là @unique -> findUnique. Trả cả dòng đã thu hồi/hết hạn: service tự quyết định (vd phát hiện dùng lại).
  findByTokenHash(tokenHash: string, db: Db = this.prisma) {
    return db.session.findUnique({ where: { tokenHash } });
  }

  // Thu hồi session cũ khi xoay vòng. Điều kiện revokedAt: null -> hai request refresh cùng lúc chỉ MỘT thắng.
  // Trả count: 1 = mình thu hồi được, 0 = request khác đã xoay trước (service ném lỗi để rollback session mới).
  async revokeActive(id: string, replacedById: string, db: Db = this.prisma) {
    const { count } = await db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById },
    });
    return count;
  }

  // Logout. Không tìm thấy / đã thu hồi -> count 0, không lỗi: logout gọi nhiều lần vẫn an toàn.
  async revokeByTokenHash(tokenHash: string, db: Db = this.prisma) {
    const { count } = await db.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  // Đổi mật khẩu / đăng xuất mọi thiết bị: thu hồi mọi phiên còn sống của user.
  async revokeAllOfUser(userId: string, db: Db = this.prisma) {
    const { count } = await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  // Phát hiện token đã bị thay mà vẫn được dùng -> giết cả family (một lần đăng nhập trên một thiết bị).
  // Gọi NGOÀI transaction rồi mới throw: ném lỗi trong $transaction sẽ rollback luôn việc thu hồi này.
  async revokeFamily(familyId: string, db: Db = this.prisma) {
    const { count } = await db.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }
}
