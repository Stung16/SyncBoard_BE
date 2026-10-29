import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Env } from '../../../config/env.validation.js';
import { MailService } from '../../../infra/mail/mail.service.js';
import {
  EMAIL_VERIFICATION_REQUESTED,
  type EmailVerificationRequestedEvent,
} from '../events/email-verification-requested.event.js';
import { USER_REGISTERED } from '../events/user-registered.event.js';

@Injectable()
export class VerificationMailListener {
  private readonly logger = new Logger(VerificationMailListener.name);

  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // async: chạy ở lượt sau của event loop -> register trả response ngay, không chờ SMTP.
  // shortcut: event chỉ nằm trong RAM của node này, process chết giữa lúc commit và lúc gửi thì mất mail (người dùng bấm "gửi lại");
  //           cần chắc chắn gửi (retry, sống qua restart) thì đổi sang hàng đợi (BullMQ trên Redis) hoặc outbox.
  // Chồng nhiều @OnEvent = nghe nhiều event. Đừng viết @OnEvent([A, B]): với eventemitter2 đó là MỘT event tên "A.B".
  @OnEvent(USER_REGISTERED, { async: true })
  @OnEvent(EMAIL_VERIFICATION_REQUESTED, { async: true })
  async sendVerificationMail(event: EmailVerificationRequestedEvent) {
    // Link trỏ về frontend (frontend gọi POST /verify-email): trình quét email tự bấm link GET sẽ dùng mất token.
    const link = `${this.config.get('APP_URL', { infer: true })}/verify-email?token=${event.verifyToken}`;
    // Tự bắt để log có userId; thư viện cũng bắt (suppressErrors mặc định true) nên lỗi không bao giờ làm sập process.
    await this.mail
      .send(event.email, 'Xác minh email SyncBoard', link)
      .catch((err: unknown) =>
        this.logger.warn(
          `Không gửi được mail xác minh cho user ${event.userId}: ${String(err)}`,
        ),
      );
  }
}
