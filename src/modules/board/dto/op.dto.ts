import { z } from 'zod';
import { elementId, elementSchema } from './element.dto.js';

const opId = z.uuid(); // client sinh; gửi lại do rớt mạng -> server thấy trùng thì bỏ qua (idempotent, GĐ3)

export const opSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('add'), opId, element: elementSchema }),
  z.strictObject({
    type: z.literal('update'),
    opId,
    elementId,
    baseVersion: z.int().min(0), // version client đang thấy lúc sửa -> phát hiện xung đột (7.2)
    patch: z.record(z.string().max(64), z.unknown()), // CHỈ kiểm khung ở đây; nội dung patch do domain kiểm (bước 3)
  }),
  z.strictObject({ type: z.literal('delete'), opId, elementId }),
  // Dùng .refine, KHÔNG tách thành z.union 2 object lồng trong discriminatedUnion: Zod ném lỗi lúc parse -> client nhận 500.
  z
    .strictObject({
      type: z.literal('restore'),
      opId,
      elementId: elementId.optional(),
      clearSeq: z.int().min(1).optional(),
    })
    .refine((o) => (o.elementId === undefined) !== (o.clearSeq === undefined), {
      error: 'restore needs exactly one of elementId, clearSeq',
    }),
  z.strictObject({
    type: z.literal('reorder'),
    opId,
    elementId,
    position: z.enum(['front', 'back', 'forward', 'backward']),
  }),
  z.strictObject({ type: z.literal('clear'), opId }),
]);
export type OpDto = z.infer<typeof opSchema>;

// Bọc trong { ops } chứ không gửi mảng trần: sau này thêm field (vd clientTime) không phải đổi giao thức.
export const submitOpsSchema = z
  .strictObject({ ops: z.array(opSchema).min(1).max(100) }) // tối đa 100 op/lô (8.3)
  .refine((b) => b.ops.length === 1 || !b.ops.some((o) => o.type === 'clear'), {
    error: 'clear must be the only op in its batch', // UC 1.7: xóa sạch bảng phải đi một mình
    path: ['ops'],
  });
export type SubmitOpsDto = z.infer<typeof submitOpsSchema>;
