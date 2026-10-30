import { z } from 'zod';
import {
  elementDataSchemas,
  elementId,
  type ElementType,
} from '../dto/element.dto.js';
import type { OpDto } from '../dto/op.dto.js';

// Hình dạng element domain làm việc (khớp các cột bảng elements, nhưng KHÔNG import Prisma)
export type ElementState = {
  id: string;
  type: ElementType;
  data: Record<string, unknown>;
  zIndex: string;
  version: number;
  isDeleted: boolean;
  locked: boolean;
  groupId: string | null;
  frameId: string | null;
  updatedBy: string;
};

// Một op server đã nhận + kết quả CUỐI (do server quyết). Phát trong OpsApplied, lưu ở operations.payload, phát lại trong MissedOps.
export type AppliedOp =
  | { opId: string; seq: number; type: 'add' | 'update' | 'delete' | 'restore'; element: ElementState }
  | { opId: string; seq: number; type: 'clear'; clearedIds: string[] };

export type RejectReason =
  | 'already_exists'
  | 'not_found'
  | 'deleted'
  | 'not_deleted'
  | 'locked'
  | 'invalid_base_version'
  | 'empty_patch'
  | 'invalid_patch'
  | 'invalid_data'
  | 'unsupported_op';

export type ApplyResult =
  | { ok: true; next: ElementState; stale: boolean } // stale: baseVersion cũ hơn (có người sửa trước) nhưng vẫn áp (LWW)
  | { ok: false; reason: RejectReason };

export type ApplyCtx = {
  actor: string; // userId người gửi -> updatedBy
  zIndexFor: () => string; // service tính zIndex "trên cùng" (GĐ1); domain không tự tính
};

// Patch được phép đụng 3 cột meta này; còn lại phải là trường của data.
const metaPatchSchema = z
  .strictObject({
    locked: z.boolean(),
    groupId: elementId.nullable(),
    frameId: elementId.nullable(),
  })
  .partial();
const META_KEYS = new Set(['locked', 'groupId', 'frameId']);

// .partial() vẫn strict: khóa lạ (kể cả __proto__, constructor) -> lỗi. Patch {} thì qua -> applyUpdate tự kiểm empty_patch.
const validatePatch = (type: ElementType, dataPatch: Record<string, unknown>) =>
  elementDataSchemas[type].partial().safeParse(dataPatch);

const reject = (reason: RejectReason): ApplyResult => ({ ok: false, reason });

// Mọi thay đổi được chấp nhận đều: tạo bản sao mới (không sửa current), version + 1, ghi người sửa.
const bump = (
  current: ElementState,
  ctx: ApplyCtx,
  changes: Partial<ElementState>,
): ElementState => ({
  ...current,
  ...changes,
  version: current.version + 1,
  updatedBy: ctx.actor,
});

export function applyOp(
  current: ElementState | undefined,
  op: OpDto,
  ctx: ApplyCtx,
): ApplyResult {
  switch (op.type) {
    case 'add': {
      // Id do client sinh: trùng (kể cả với element đã xóa mềm) là lỗi của client.
      if (current) return reject('already_exists');
      const { id, type, data, groupId, frameId } = op.element;
      // Schema op đã kiểm, nhưng domain còn được gọi từ đường khác (import) không qua pipe -> kiểm lại.
      const parsed = elementDataSchemas[type].safeParse(data);
      if (!parsed.success) return reject('invalid_data');
      return {
        ok: true,
        stale: false,
        next: {
          id,
          type,
          data: parsed.data,
          zIndex: ctx.zIndexFor(), // server cấp, không nhận zIndex từ client
          version: 1,
          isDeleted: false,
          locked: false,
          groupId: groupId ?? null,
          frameId: frameId ?? null,
          updatedBy: ctx.actor,
        },
      };
    }
    case 'update':
      return applyUpdate(current, op, ctx);
    case 'delete':
      if (!current) return reject('not_found');
      if (current.isDeleted) return reject('deleted');
      if (current.locked) return reject('locked');
      // Xóa mềm: giữ nguyên data để restore / undo được.
      return {
        ok: true,
        stale: false,
        next: bump(current, ctx, { isDeleted: true }),
      };
    case 'restore':
      if (op.elementId === undefined) return reject('unsupported_op'); // restore { clearSeq } do service xử lý (GĐ3)
      if (!current) return reject('not_found');
      if (!current.isDeleted) return reject('not_deleted'); // client undo gặp lý do này thì bỏ qua lượt
      return {
        ok: true,
        stale: false,
        next: bump(current, ctx, { isDeleted: false }),
      };
    default:
      return reject('unsupported_op'); // reorder (GĐ2), clear (service chạy updateMany)
  }
}

function applyUpdate(
  current: ElementState | undefined,
  op: Extract<OpDto, { type: 'update' }>,
  ctx: ApplyCtx,
): ApplyResult {
  if (!current) return reject('not_found');
  if (current.isDeleted) return reject('deleted');

  const entries = Object.entries(op.patch);
  if (entries.length === 0) return reject('empty_patch');

  // Đang khóa: CHỈ cho đúng patch { locked: false }. Cho trộn { locked: false, x: 5 } là thủng luật khóa.
  const unlockOnly = entries.length === 1 && op.patch.locked === false;
  if (current.locked && !unlockOnly) return reject('locked');

  // baseVersion lớn hơn version hiện có = không thể xảy ra -> lỗi client. NHỎ hơn thì vẫn áp: đó là LWW.
  if (op.baseVersion > current.version) return reject('invalid_base_version');

  // Object.fromEntries tạo own property -> khóa "__proto__" không đổi được prototype (obj[k] = v thì có).
  const metaPatch = Object.fromEntries(
    entries.filter(([k]) => META_KEYS.has(k)),
  );
  const dataPatch = Object.fromEntries(
    entries.filter(([k]) => !META_KEYS.has(k)),
  );

  // id, version, isDeleted, zIndex, __proto__... không thuộc meta, không có trong schema data -> bị chặn tại đây
  const meta = metaPatchSchema.safeParse(metaPatch);
  const data = validatePatch(current.type, dataPatch);
  if (!meta.success || !data.success) return reject('invalid_patch');

  return {
    ok: true,
    stale: op.baseVersion < current.version,
    next: bump(current, ctx, {
      ...meta.data,
      data: { ...current.data, ...data.data }, // merge NÔNG: patch points = thay CẢ mảng
    }),
  };
}
