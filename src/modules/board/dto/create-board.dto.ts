
import { z } from 'zod';

export const createBoardSchema = z.strictObject({
  title: z.string().trim().min(1).max(50).optional(), // tên tối đa 50 ký tự (8.3); thiếu -> DB đặt "Untitled"
});
export type CreateBoardDto = z.infer<typeof createBoardSchema>;
