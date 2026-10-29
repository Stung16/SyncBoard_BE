// Phát SAU khi token đặt lại mật khẩu đã commit (người dùng bấm "quên mật khẩu").
export const PASSWORD_RESET_REQUESTED = 'auth.password-reset-requested';

export interface PasswordResetRequestedEvent {
  userId: string;
  email: string;
  displayName: string;
  resetToken: string; // token gốc để dựng link; DB chỉ có sha256 của nó
}
