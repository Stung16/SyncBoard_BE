import { z } from 'zod';
import { registerSchema } from './register.dto.js';
import { verifyEmailSchema } from './verify-email.dto.js';

// Lấy lại luật email/mật khẩu của register: đổi luật một chỗ là áp cho cả đặt lại mật khẩu.
export const forgotPasswordSchema = z.strictObject({
  email: registerSchema.shape.email,
});
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.strictObject({
  token: verifyEmailSchema.shape.token,
  password: registerSchema.shape.password,
});
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
