import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  async send(to: string, subject: string, link: string) {
    this.logger.log(`[MAIL] to=${to} | ${subject} | ${link}`);
  }
}
