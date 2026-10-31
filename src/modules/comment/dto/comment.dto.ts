import { z } from 'zod';
import { coord, elementId } from '../../board/dto/element.dto.js';

const body = z.string().trim().min(1).max(5000);

// Comment gốc gắn vào MỘT chỗ: một element HOẶC một điểm (x, y). Trả lời (có parentId) thì không gắn: nằm theo comment gốc.
export const createCommentSchema = z
  .strictObject({
    body,
    elementId: elementId.optional(),
    x: coord.optional(),
    y: coord.optional(),
    parentId: z.uuid().optional(),
    // Client gửi danh sách userId được @ (không để server tách "@Tên" trong body: tên trùng / có dấu cách sẽ nhắc nhầm người)
    mentions: z.array(z.uuid()).max(50).optional(),
  })
  .refine((c) => (c.x === undefined) === (c.y === undefined), { error: 'x and y go together', path: ['x'] })
  .refine((c) => (c.parentId ? c.elementId === undefined && c.x === undefined : (c.elementId === undefined) !== (c.x === undefined)), {
    error: 'a comment needs exactly one anchor (elementId or x/y); a reply has none',
    path: ['elementId'],
  });
export type CreateCommentDto = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z
  .strictObject({ body: body.optional(), resolved: z.boolean().optional() })
  .refine((c) => c.body !== undefined || c.resolved !== undefined, { error: 'nothing to update' });
export type UpdateCommentDto = z.infer<typeof updateCommentSchema>;
