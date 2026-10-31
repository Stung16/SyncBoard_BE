import { z } from 'zod';
import { coord, elementId } from '../../board/dto/element.dto.js';

// Sự kiện tạm: không lưu DB nhưng vẫn kiểm (server chuyển tiếp cho cả phòng -> không để client phát rác cho người khác).

export const cursorSchema = z.strictObject({ x: coord, y: coord }); // tọa độ bảng, không phải tọa độ màn hình
export type CursorDto = z.infer<typeof cursorSchema>;

export const viewportSchema = z.strictObject({ x: coord, y: coord, zoom: z.number().min(0.01).max(100) });
export type ViewportDto = z.infer<typeof viewportSchema>;

export const selectionSchema = z.strictObject({
  elementIds: z.array(elementId).max(1000),
  editingElementId: elementId.nullable().optional(), // đang sửa chữ ô này = khóa mềm (7.3)
});
export type SelectionDto = z.infer<typeof selectionSchema>;

const point = z.tuple([coord, coord]);
export const ephemeralSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('laser'), payload: z.strictObject({ x: coord, y: coord }) }),
  z.strictObject({ kind: z.literal('emote'), payload: z.strictObject({ emoji: z.string().min(1).max(16), x: coord, y: coord }) }),
  z.strictObject({ kind: z.literal('cursorChat'), payload: z.strictObject({ text: z.string().max(100) }) }),
  z.strictObject({ kind: z.literal('dragPreview'), payload: z.strictObject({ elementIds: z.array(elementId).max(1000), dx: coord, dy: coord }) }),
  // nét đang vẽ dở (UC 2.5): gửi từng khúc điểm mới mỗi ~50ms
  z.strictObject({ kind: z.literal('strokeProgress'), payload: z.strictObject({ elementId, points: z.array(point).max(200) }) }),
]);
export type EphemeralDto = z.infer<typeof ephemeralSchema>;

export const pingSchema = z.strictObject({ clientTime: z.number() });
export type PingDto = z.infer<typeof pingSchema>;
