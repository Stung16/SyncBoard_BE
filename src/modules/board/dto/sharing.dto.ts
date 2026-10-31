import { z } from 'zod';

// OWNER không cấp được qua link, lời mời hay đổi vai trò: mỗi bảng đúng một chủ (người tạo).
const grantableRole = z.enum(['EDITOR', 'COMMENTER', 'VIEWER']);

export const createShareLinkSchema = z.strictObject({
  role: grantableRole,
  expiresInHours: z.int().min(1).max(24 * 365).optional(), // thiếu = không hết hạn (chỉ thu hồi tay)
});
export type CreateShareLinkDto = z.infer<typeof createShareLinkSchema>;

export const changeRoleSchema = z.strictObject({ role: grantableRole });
export type ChangeRoleDto = z.infer<typeof changeRoleSchema>;

export const createInvitationSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)), // giống register: so khớp email lúc chấp nhận
  role: grantableRole,
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.strictObject({ token: z.string().min(1).max(100) });
export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;
