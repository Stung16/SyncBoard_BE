
// Phát SAU khi token mới đã commit (người dùng bấm "gửi lại link xác minh").

import { UserRegisteredEvent } from "./user-registered.event.js";

// Không dùng lại USER_REGISTERED: listener kiểu "mail chào mừng" sau này sẽ chạy nhầm mỗi lần gửi lại.
export const EMAIL_VERIFICATION_REQUESTED = 'auth.email-verification-requested';

export type EmailVerificationRequestedEvent = UserRegisteredEvent; // cùng dữ liệu để dựng mail
