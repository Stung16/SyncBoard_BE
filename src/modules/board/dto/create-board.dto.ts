
import { z } from 'zod';

export const createBoardSchema = z.strictObject({
  title: z.string().trim().min(1).max(50).optional(), // tên tối đa 50 ký tự (8.3); thiếu -> DB đặt "Untitled"
});
export type CreateBoardDto = z.infer<typeof createBoardSchema>;

export const renameBoardSchema = z.strictObject({ title: z.string().trim().min(1).max(50) });
export type RenameBoardDto = z.infer<typeof renameBoardSchema>;

// GET /boards?search=: tìm theo tên, không phân biệt hoa thường. Rỗng = tất cả.
export const listBoardsSchema = z.strictObject({ search: z.string().trim().max(50).optional() });
export type ListBoardsDto = z.infer<typeof listBoardsSchema>;
