import { z } from 'zod';

export const registerSchema = z.strictObject({
  // Cắt khoảng trắng + chữ thường TRƯỚC rồi mới kiểm định dạng: người dùng hay dán email kèm dấu cách. 254 = độ dài tối đa của email
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(8).max(128), // max: argon2 với chuỗi cực dài vẫn tốn CPU -> chặn DoS
  displayName: z.string().trim().min(1).max(50),
});
export type RegisterDto = z.infer<typeof registerSchema>;
