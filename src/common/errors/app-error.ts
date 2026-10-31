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
  USER_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Tài khoản không tồn tại',
  },
  INVALID_RESET_TOKEN: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Link đặt lại mật khẩu không hợp lệ hoặc đã hết hạn',
  },
  INVALID_REFRESH_TOKEN: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại',
  },
  BOARD_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Bảng không tồn tại',
  },
  BOARD_FORBIDDEN: {
    status: HttpStatus.FORBIDDEN,
    message: 'Bạn không có quyền làm việc này trên bảng',
  },
  MEMBER_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Thành viên không tồn tại',
  },
  OWNER_ROLE_FIXED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Không thể đổi vai trò hoặc xóa chủ bảng',
  },
  SHARE_LINK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Link chia sẻ không tồn tại hoặc đã bị thu hồi',
  },
  SNAPSHOT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Phiên bản không tồn tại',
  },
  INVALID_IMAGE: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Chỉ nhận ảnh PNG, JPEG, GIF hoặc WebP',
  },
  ASSET_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Ảnh không tồn tại',
  },
  COMMENT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Bình luận không tồn tại',
  },
  INVALID_PARENT_COMMENT: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Chỉ trả lời được bình luận gốc của cùng bảng',
  },
  NOT_COMMENT_AUTHOR: {
    status: HttpStatus.FORBIDDEN,
    message: 'Chỉ người viết mới sửa được bình luận này',
  },
  SHUTTING_DOWN: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Máy chủ đang khởi động lại, vui lòng thử lại',
  },
  INVITATION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Lời mời không tồn tại hoặc đã bị thu hồi',
  },
  INVALID_INVITATION: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Lời mời không hợp lệ hoặc đã hết hạn',
  },
  INVITATION_EMAIL_MISMATCH: {
    status: HttpStatus.FORBIDDEN,
    message: 'Lời mời này dành cho một email khác',
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
