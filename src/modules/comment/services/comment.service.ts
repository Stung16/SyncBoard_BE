import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../infra/database/prisma.service.js';
import { SocketEmitter } from '../../../infra/socket/socket-emitter.service.js';
import { SharingService } from '../../board/services/sharing.service.js';
import { NotificationService } from '../../notification/services/notification.service.js';
import { UserService } from '../../user/services/user.service.js';
import type { CreateCommentDto, UpdateCommentDto } from '../dto/comment.dto.js';
import { CommentRepository } from '../repositories/comment.repository.js';

// shortcut: tải tối đa 1.000 comment/bảng một lần, chưa phân trang. Bảng nhiều hơn thì thêm cursor theo createdAt.
const LIST_LIMIT = 1000;

@Injectable()
export class CommentService {
  constructor(
    private readonly prisma: PrismaService, // chỉ để mở transaction
    private readonly comments: CommentRepository,
    private readonly sharing: SharingService,
    private readonly notifications: NotificationService,
    private readonly users: UserService,
    private readonly emitter: SocketEmitter,
  ) {}

  async list(boardId: string, userId: string) {
    await this.sharing.authorize(boardId, userId, 'view');
    return this.comments.list(boardId, LIST_LIMIT);
  }

  // 5.1 + 5.2: lưu comment và thông báo trong MỘT transaction, phát SAU commit (phát trước thì client tải lại không thấy comment).
  async create(boardId: string, userId: string, { body, elementId, x, y, parentId, mentions = [] }: CreateCommentDto) {
    const { title } = await this.sharing.authorize(boardId, userId, 'comment');
    const parent = parentId ? await this.comments.findInBoard(boardId, parentId) : null;
    // Chỉ một tầng trả lời: trả lời một câu trả lời thì client gửi parentId của comment gốc
    if (parentId && (!parent || parent.parentId)) throw new AppError('INVALID_PARENT_COMMENT', 'parentId');

    // Ai nhận thông báo: người được @ + tác giả comment gốc, bỏ chính mình, và CHỈ thành viên bảng
    const candidates = [...new Set([...mentions, ...(parent ? [parent.authorId] : [])])].filter((id) => id !== userId);
    const recipients = await this.sharing.filterMembers(boardId, candidates);
    const author = await this.users.getById(userId);

    const { comment, created } = await this.prisma.$transaction(async (tx) => {
      const comment = await this.comments.create({ boardId, authorId: userId, body, elementId, x, y, parentId }, tx);
      const data = { boardTitle: title, authorName: author.displayName, excerpt: body.slice(0, 100) }; // chụp lúc tạo, khỏi join khi hiển thị
      const created = await this.notifications.create(
        recipients.map((recipient) => ({
          userId: recipient,
          type: mentions.includes(recipient) ? 'MENTION' : 'COMMENT_REPLY', // vừa được @ vừa là tác giả gốc -> chỉ một thông báo MENTION
          actorId: userId,
          boardId,
          commentId: comment.id,
          data,
        })),
        tx,
      );
      return { comment, created };
    });

    this.emitter.toBoard(boardId, 'CommentAdded', comment);
    this.notifications.publish(created);
    return comment;
  }

  // Sửa nội dung: chỉ tác giả. Đánh dấu đã xử lý / mở lại: ai bình luận được đều làm được.
  // shortcut: sửa body không tạo thông báo cho người mới được @ (chỉ lúc tạo mới báo).
  async update(boardId: string, userId: string, commentId: string, { body, resolved }: UpdateCommentDto) {
    await this.sharing.authorize(boardId, userId, 'comment');
    const current = await this.requireComment(boardId, commentId);
    if (body !== undefined && current.authorId !== userId) throw new AppError('NOT_COMMENT_AUTHOR');
    const comment = await this.comments.update(commentId, {
      ...(body !== undefined && { body }),
      ...(resolved !== undefined && { resolvedAt: resolved ? new Date() : null }),
    });
    this.emitter.toBoard(boardId, 'CommentUpdated', comment);
    return comment;
  }

  // Tác giả hoặc chủ bảng (dọn bình luận rác). Xóa comment gốc thì các trả lời đi theo.
  async remove(boardId: string, userId: string, commentId: string) {
    const { role } = await this.sharing.authorize(boardId, userId, 'comment');
    const current = await this.requireComment(boardId, commentId);
    if (current.authorId !== userId && role !== 'OWNER') throw new AppError('NOT_COMMENT_AUTHOR');
    await this.comments.delete(commentId);
    this.emitter.toBoard(boardId, 'CommentDeleted', { id: commentId });
  }

  private async requireComment(boardId: string, commentId: string) {
    const comment = await this.comments.findInBoard(boardId, commentId);
    if (!comment) throw new AppError('COMMENT_NOT_FOUND');
    return comment;
  }
}
