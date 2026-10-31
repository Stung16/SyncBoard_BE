import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppError } from '../../../common/errors/app-error.js';
import { randomToken, sha256 } from '../../../common/utils/token.util.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { SocketEmitter } from '../../../infra/socket/socket-emitter.service.js';
import { UserService } from '../../user/services/user.service.js';
import { can, type Action, type Role } from '../domain/permissions.js';
import type { ChangeRoleDto, CreateInvitationDto, CreateShareLinkDto } from '../dto/sharing.dto.js';
import { BOARD_INVITATION_CREATED, type BoardInvitationCreatedEvent } from '../events/board-invitation-created.event.js';
import { BoardRepository } from '../repositories/board.repository.js';
import { InvitationRepository } from '../repositories/invitation.repository.js';
import { MemberRepository } from '../repositories/member.repository.js';
import { ShareLinkRepository } from '../repositories/share-link.repository.js';

// room: socket vào thêm room này lúc JoinBoard; quyền đổi/thu hồi thì đá đúng room đó (8.2).
// member:{boardId}:{userId} chứ không phải user:{userId}: đổi quyền bảng A không được đá người đó khỏi bảng B.
export type Access = { role: Role; room: string };
const memberRoom = (boardId: string, userId: string) => `member:${boardId}:${userId}`;
const shareRoom = (linkId: string) => `share:${linkId}`;
// Vai trò không cần link: thành viên, hoặc bảng không chủ (seed demo) thì ai cũng EDITOR (8.1)
const roleOf = (board: { ownerId: string | null; members: { role: Role }[] }): Role | null =>
  board.members[0]?.role ?? (board.ownerId ? null : 'EDITOR');

const INVITATION_TTL_MS = 7 * 24 * 3600_000;

@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService, // chỉ để mở transaction
    private readonly boards: BoardRepository,
    private readonly members: MemberRepository,
    private readonly links: ShareLinkRepository,
    private readonly invitations: InvitationRepository,
    private readonly users: UserService,
    private readonly emitter: SocketEmitter,
    private readonly events: EventEmitter2,
  ) {}

  // null = không có bảng HOẶC không có quyền: trả giống nhau để người lạ không dò được id bảng nào tồn tại.
  async resolveAccess(boardId: string, userId: string, shareToken?: string): Promise<Access | null> {
    const board = await this.boards.findWithMember(boardId, userId);
    if (!board) return null;
    // Thành viên thì dùng vai trò thành viên, kể cả khi cầm link quyền cao hơn: chủ bảng đã chọn vai trò cho riêng người này.
    const role = roleOf(board);
    if (role) return { role, room: memberRoom(boardId, userId) };
    if (shareToken) {
      const link = await this.links.findUsableByToken(boardId, shareToken);
      if (link) return { role: link.role, room: shareRoom(link.id) };
    }
    return null;
  }

  // Kiểm quyền cho REST. 404 khi không có quyền gì (không lộ bảng tồn tại), 403 khi có vai trò nhưng không đủ.
  // shortcut: REST chưa nhận share token -> người vào bằng link chỉ dùng được socket, không xem được lịch sử phiên bản.
  async authorize(boardId: string, userId: string, action: Action) {
    const board = await this.boards.findWithMember(boardId, userId);
    const role = board && roleOf(board);
    if (!board || !role) throw new AppError('BOARD_NOT_FOUND');
    if (!can(role, action)) throw new AppError('BOARD_FORBIDDEN');
    return board;
  }

  // --- Thành viên ---

  async listMembers(boardId: string, actorId: string) {
    await this.requireOwner(boardId, actorId);
    return (await this.members.list(boardId)).map(({ role, user: { id, ...user } }) => ({ userId: id, ...user, role }));
  }

  async changeRole(boardId: string, actorId: string, userId: string, { role }: ChangeRoleDto) {
    await this.requireOwner(boardId, actorId);
    const current = await this.requireNonOwnerMember(boardId, userId);
    if (current.role === role) return { userId, role };
    const updated = await this.members.updateRole(boardId, userId, role);
    // Không sửa role trong socket.data được (socket có thể ở node khác) -> đá ra, client JoinBoard lại để nhận vai trò mới
    this.emitter.kickFromBoard(memberRoom(boardId, userId), 'role_changed');
    return updated;
  }

  async removeMember(boardId: string, actorId: string, userId: string) {
    await this.requireOwner(boardId, actorId);
    await this.requireNonOwnerMember(boardId, userId);
    await this.members.delete(boardId, userId);
    this.emitter.kickFromBoard(memberRoom(boardId, userId), 'removed');
  }

  // --- Link chia sẻ (6.4) ---

  async createLink(boardId: string, actorId: string, { role, expiresInHours }: CreateShareLinkDto) {
    await this.requireOwner(boardId, actorId);
    const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600_000) : null;
    return this.links.create({ boardId, role, createdBy: actorId, token: randomToken(), expiresAt });
  }

  async listLinks(boardId: string, actorId: string) {
    await this.requireOwner(boardId, actorId);
    return this.links.findUsable(boardId);
  }

  async revokeLink(boardId: string, actorId: string, linkId: string) {
    await this.requireOwner(boardId, actorId);
    if ((await this.links.revoke(boardId, linkId)) === 0) throw new AppError('SHARE_LINK_NOT_FOUND');
    // shortcut: ai đang JoinBoard bằng link ĐÚNG lúc thu hồi (đã đọc link còn hạn, chưa kịp vào room share:) thì sót lại tới lần nối lại sau.
    this.emitter.kickFromBoard(shareRoom(linkId), 'link_revoked');
  }

  // --- Lời mời qua email (6.3) ---

  async invite(boardId: string, actorId: string, { email, role }: CreateInvitationDto) {
    const board = await this.requireOwner(boardId, actorId);
    const inviter = await this.users.getById(actorId);
    const token = randomToken();
    const invitation = await this.invitations.create({
      boardId,
      email,
      role,
      tokenHash: sha256(token), // lời mời "đăng nhập được" vào bảng -> chỉ lưu hash (quy ước trong schema)
      invitedById: actorId,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });
    // shortcut: chưa chặn mời người đã là thành viên / mời trùng email; chấp nhận vẫn an toàn (addIfMissing giữ vai trò cũ).
    this.events.emit(BOARD_INVITATION_CREATED, {
      invitationId: invitation.id,
      email,
      boardTitle: board.title,
      inviterName: inviter.displayName,
      token,
    } satisfies BoardInvitationCreatedEvent);
    return invitation;
  }

  async listInvitations(boardId: string, actorId: string) {
    await this.requireOwner(boardId, actorId);
    return this.invitations.findPending(boardId);
  }

  async revokeInvitation(boardId: string, actorId: string, invitationId: string) {
    await this.requireOwner(boardId, actorId);
    if ((await this.invitations.revoke(boardId, invitationId)) === 0) throw new AppError('INVITATION_NOT_FOUND');
  }

  async acceptInvitation(userId: string, token: string) {
    const invitation = await this.invitations.findPendingByHash(sha256(token));
    if (!invitation) throw new AppError('INVALID_INVITATION');
    // Lời mời gửi cho một email -> chỉ đúng chủ email đó dùng được (link bị chuyển tiếp cho người khác thì vô dụng)
    const user = await this.users.getById(userId);
    if (user.email !== invitation.email) throw new AppError('INVITATION_EMAIL_MISMATCH');

    const member = await this.prisma.$transaction(async (tx) => {
      if ((await this.invitations.markAccepted(invitation.id, tx)) === 0) throw new AppError('INVALID_INVITATION'); // vừa bị thu hồi/dùng
      return this.members.addIfMissing(invitation.boardId, userId, invitation.role, tx);
    });
    return { boardId: invitation.boardId, role: member.role };
  }

  private requireOwner(boardId: string, actorId: string) {
    return this.authorize(boardId, actorId, 'manageSharing');
  }

  private async requireNonOwnerMember(boardId: string, userId: string) {
    const member = await this.members.find(boardId, userId);
    if (!member) throw new AppError('MEMBER_NOT_FOUND');
    if (member.role === 'OWNER') throw new AppError('OWNER_ROLE_FIXED');
    return member;
  }
}
