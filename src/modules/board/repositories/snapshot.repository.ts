import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';

type Db = Prisma.TransactionClient;

const LIST_FIELDS = { id: true, seq: true, label: true, createdAt: true } as const;

// Chỉ chứa query bảng snapshots.
@Injectable()
export class SnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ON CONFLICT DO NOTHING trên (board_id, seq): đã có bản chụp ở seq này (node khác, hoặc lần chạy trước) thì bỏ qua.
  // Không dùng create + bắt P2002: trong transaction, lỗi unique làm hỏng cả transaction của Postgres.
  async createIfAbsent(data: Prisma.SnapshotUncheckedCreateInput, db: Db = this.prisma) {
    const { count } = await db.snapshot.createMany({ data, skipDuplicates: true });
    return count;
  }

  list(boardId: string, take: number) {
    return this.prisma.snapshot.findMany({ where: { boardId }, orderBy: { seq: 'desc' }, take, select: LIST_FIELDS });
  }

  find(boardId: string, id: string, db: Db = this.prisma) {
    return db.snapshot.findFirst({ where: { id, boardId }, select: { ...LIST_FIELDS, data: true } });
  }

  // Bảng có op mới kể từ bản chụp gần nhất. max(seq) đi theo unique index (board_id, seq).
  async findChangedBoardIds() {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT b.id FROM boards b
      WHERE b.deleted_at IS NULL
        AND b.last_seq > COALESCE((SELECT max(s.seq) FROM snapshots s WHERE s.board_id = b.id), 0)`;
    return rows.map((r) => r.id);
  }
}
