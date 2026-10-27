import { HttpStatus } from '@nestjs/common';

// Mã lỗi nghiệp vụ: code -> status + câu cho người dùng. FE xử lý theo `code`, không parse `message`.
// Thêm lỗi mới = thêm một dòng ở đây; thiếu status hoặc gõ sai code đều là lỗi biên dịch.
export const ERRORS = {
  EMAIL_TAKEN: { status: HttpStatus.CONFLICT, message: 'Email đã được sử dụng' },
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
