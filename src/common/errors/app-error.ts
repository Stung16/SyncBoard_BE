import { HttpStatus } from '@nestjs/common';

// Mã lỗi nghiệp vụ: code -> status + câu cho người dùng. FE xử lý theo `code`, không parse `message`.
// Thêm lỗi mới = thêm một dòng ở đây; thiếu status hoặc gõ sai code đều là lỗi biên dịch.
export const ERRORS = {
  EMAIL_TAKEN: {
    status: HttpStatus.CONFLICT,
    message: 'Email đã được sử dụng',
  },
  INVALID_VERIFY_TOKEN: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Link xác minh không hợp lệ hoặc đã hết hạn',
  },
  INVALID_CREDENTIALS: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Email hoặc mật khẩu không đúng',
  },
  EMAIL_NOT_VERIFIED: {
    status: HttpStatus.FORBIDDEN,
    message: 'Vui lòng xác minh email trước khi đăng nhập',
  },
  RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Bạn thao tác quá nhanh, vui lòng thử lại sau',
  },
} as const satisfies Record<string, { status: HttpStatus; message: string }>;

export type ErrorCode = keyof typeof ERRORS;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly field?: string, // ô nhập bị lỗi, để FE hiện lỗi ngay dưới ô đó
    readonly details?: Record<string, unknown>,
  ) {
    super(ERRORS[code].message);
    this.name = 'AppError';
  }

  get status(): number {
    return ERRORS[this.code].status;
  }
}
