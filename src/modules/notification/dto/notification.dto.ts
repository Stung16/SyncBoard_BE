import { z } from 'zod';

// Query string luôn là chuỗi -> nhận đúng "true"/"false" thay vì ép kiểu (z.coerce.boolean() biến "false" thành true)
export const listNotificationsSchema = z.strictObject({ unread: z.enum(['true', 'false']).optional() });
export type ListNotificationsDto = z.infer<typeof listNotificationsSchema>;
