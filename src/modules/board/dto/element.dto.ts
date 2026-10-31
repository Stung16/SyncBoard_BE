import { z } from 'zod';

// --- Các mảnh dùng chung ---
// z.number() của Zod 4 đã từ chối NaN và Infinity. Thêm min/max: số khổng lồ làm canvas vẽ sai và mất độ chính xác.
export const coord = z.number().min(-1e7).max(1e7);
const size = z.number().min(0).max(1e7);
const opacity = z.number().min(0).max(1);
// Chỉ nhận màu hex (#rrggbb hoặc #rrggbbaa) hoặc 'transparent': chặn chuỗi rác/khổng lồ lọt vào DB rồi phát cho cả phòng.
const color = z
  .string()
  .regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
  .or(z.literal('transparent'));

export const elementId = z.string().min(1).max(64); // client tự sinh (UUID), chỉ cần duy nhất trong một bảng

// --- data riêng theo từng type (bảng 4.2 của spec) ---
// strictObject: khóa lạ trong data -> từ chối, không để client nhét field tùy ý vào DB.
const shapeData = z.strictObject({
  x: coord,
  y: coord,
  width: size,
  height: size,
  angle: z.number(),
  strokeColor: color,
  fillColor: color,
  strokeWidth: z.number().min(0).max(100),
  strokeStyle: z.enum(['solid', 'dashed']),
  opacity,
});

// line / arrow: points tương đối với (x, y) như freedraw, ít nhất 2 điểm.
// binding = id hình mà đầu đó dính vào (2.11); client tự tính vị trí đầu mũi tên từ hình đó. null = không dính.
const binding = z.strictObject({ elementId }).nullable();
const linearData = z.strictObject({
  x: coord,
  y: coord,
  points: z.array(z.tuple([coord, coord])).min(2).max(5000),
  strokeColor: color,
  strokeWidth: z.number().min(0.5).max(100),
  strokeStyle: z.enum(['solid', 'dashed']),
  opacity,
  startBinding: binding,
  endBinding: binding,
  arrowhead: z.enum(['none', 'arrow', 'triangle']), // ở điểm cuối; line thường để 'none'
});

export const elementDataSchemas = {
  freedraw: z.strictObject({
    x: coord,
    y: coord,
    points: z
      .array(z.tuple([coord, coord]))
      .min(1)
      .max(5000), // [x, y] tương đối với (x, y); 5.000 điểm = giới hạn 8.3
    strokeColor: color,
    strokeWidth: z.number().min(0.5).max(100),
    opacity,
  }),
  rect: shapeData,
  ellipse: shapeData,
  diamond: shapeData,
  text: z.strictObject({
    x: coord,
    y: coord,
    width: size,
    text: z.string().max(10_000), // 8.3; chuỗi rỗng được (vừa tạo ô, chưa gõ)
    fontSize: z.number().min(1).max(500),
    color,
    align: z.enum(['left', 'center', 'right']),
  }),
  sticky: z.strictObject({
    x: coord,
    y: coord,
    width: size,
    height: size,
    text: z.string().max(10_000),
    color,
  }),
  line: linearData,
  arrow: linearData,
  frame: z.strictObject({ x: coord, y: coord, width: size, height: size, name: z.string().max(100) }), // 5.7
  // assetId = ảnh đã upload qua REST (2.10); BoardService kiểm asset đó thuộc đúng bảng
  image: z.strictObject({ x: coord, y: coord, width: size, height: size, angle: z.number(), assetId: z.uuid() }),
};
export type ElementType = keyof typeof elementDataSchemas;

// --- element đầy đủ (dùng trong op add) ---
const base = {
  id: elementId,
  groupId: elementId.nullable().optional(), // 2.6, chưa dùng ở GĐ1 nhưng để sẵn để khỏi đổi giao thức
  frameId: elementId.nullable().optional(), // 5.7
};

// discriminatedUnion theo 'type' = allowlist: type không có trong danh sách -> từ chối (UC 2.1).
export const elementSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('freedraw'),
    data: elementDataSchemas.freedraw,
  }),
  z.strictObject({
    ...base,
    type: z.enum(['rect', 'ellipse', 'diamond']),
    data: shapeData,
  }),
  z.strictObject({ ...base, type: z.enum(['line', 'arrow']), data: linearData }),
  z.strictObject({ ...base, type: z.literal('frame'), data: elementDataSchemas.frame }),
  z.strictObject({ ...base, type: z.literal('image'), data: elementDataSchemas.image }),
  z.strictObject({ ...base, type: z.literal('text'), data: elementDataSchemas.text }),
  z.strictObject({ ...base, type: z.literal('sticky'), data: elementDataSchemas.sticky }),
]);
export type ElementDto = z.infer<typeof elementSchema>;
