import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Env } from '../../../config/env.validation.js';
import { MailService } from '../../../infra/mail/mail.service.js';
import { BOARD_INVITATION_CREATED, type BoardInvitationCreatedEvent } from '../events/board-invitation-created.event.js';

@Injectable()
export class InvitationMailListener {
  private readonly logger = new Logger(InvitationMailListener.name);

  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // shortcut: event chỉ trong RAM (như mail xác minh), process chết trước khi gửi thì mất mail -> chủ bảng mời lại.
  @OnEvent(BOARD_INVITATION_CREATED, { async: true })
  async sendInvitationMail(event: BoardInvitationCreatedEvent) {
    // Trỏ về frontend (frontend gọi POST /invitations/accept): trình quét email bấm link GET không dùng mất lời mời.
    const link = `${this.config.get('APP_URL', { infer: true })}/invitations/accept?token=${event.token}`;
    await this.mail
      .send(event.email, `${event.inviterName} mời bạn vào bảng "${event.boardTitle}"`, link)
      .catch((err: unknown) => this.logger.warn(`Không gửi được mail lời mời ${event.invitationId}: ${String(err)}`));
  }
}
