import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

// Global pipe ném BadRequestException; chỉ WsException mới tới client kèm message thật.
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  constructor() {
    super({ causeFactory: (pattern) => ({ pattern }) }); // không gửi lại payload của client trong `cause`
  }

  override catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof BadRequestException) exception = new WsException(exception.getResponse());
    super.catch(exception, host);
  }
}
