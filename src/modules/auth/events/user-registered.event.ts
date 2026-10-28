// Phát SAU khi transaction đăng ký đã commit. Ai cần phản ứng (gửi mail, audit, analytics…) thì tự @OnEvent,
// AuthService không cần biết có bao nhiêu listener.
export const USER_REGISTERED = 'user.registered';

export interface UserRegisteredEvent {
  userId: string;
  email: string;
  displayName: string;
  verifyToken: string; // token gốc để dựng link; DB chỉ có sha256 của nó
}
