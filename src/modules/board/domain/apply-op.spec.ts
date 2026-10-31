import { applyOp, type ElementState } from './apply-op.js';

const ctx = { actor: 'u1', zIndexFor: () => 'a0' };
const RECT_DATA = {
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0,
  strokeColor: '#000000',
  fillColor: 'transparent',
  strokeWidth: 1,
  strokeStyle: 'solid' as const,
  opacity: 1,
};
const rect = (over: Partial<ElementState> = {}): ElementState => ({
  id: 'r1',
  type: 'rect',
  zIndex: 'a0',
  version: 3,
  isDeleted: false,
  locked: false,
  groupId: null,
  frameId: null,
  updatedBy: 'u0',
  data: { ...RECT_DATA },
  ...over,
});
const freedraw = (): ElementState => ({
  ...rect(),
  id: 'f1',
  type: 'freedraw',
  data: {
    x: 0,
    y: 0,
    points: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    strokeColor: '#000000',
    strokeWidth: 2,
    opacity: 1,
  },
});
const opId = () => crypto.randomUUID();
const update = (patch: Record<string, unknown>, baseVersion = 3) =>
  ({
    type: 'update',
    opId: opId(),
    elementId: 'r1',
    baseVersion,
    patch,
  }) as const;
const del = () => ({ type: 'delete', opId: opId(), elementId: 'r1' }) as const;
const restore = () =>
  ({ type: 'restore', opId: opId(), elementId: 'r1' }) as const;
const add = () =>
  ({
    type: 'add',
    opId: opId(),
    element: { id: 'r1', type: 'rect', data: RECT_DATA },
  }) as const;

// Chạy op rồi trả element mới; fail rõ ràng nếu bị từ chối
const nextOf = (
  cur: ElementState | undefined,
  op: Parameters<typeof applyOp>[1],
) => {
  const r = applyOp(cur, op, ctx);
  if (!r.ok) throw new Error(`bị từ chối: ${r.reason}`);
  return r.next;
};
const reasonOf = (
  cur: ElementState | undefined,
  op: Parameters<typeof applyOp>[1],
) => {
  const r = applyOp(cur, op, ctx);
  return r.ok ? 'ok' : r.reason;
};

describe('applyOp: update (LWW theo trường)', () => {
  it('đúng baseVersion: áp patch, version + 1, updatedBy = người gửi, stale false', () => {
    const r = applyOp(rect(), update({ x: 5 }), ctx);
    expect(r).toMatchObject({
      ok: true,
      stale: false,
      next: { version: 4, updatedBy: 'u1', data: { x: 5, y: 0 } },
    });
  });

  it('baseVersion cũ, khác trường: vẫn áp, GIỮ CẢ HAI thay đổi', () => {
    const afterA = nextOf(rect(), update({ x: 5 }, 3)); // A kéo hình
    const r = applyOp(afterA, update({ fillColor: '#ff0000' }, 3), ctx); // B đổi màu, vẫn thấy version 3
    expect(r).toMatchObject({
      ok: true,
      stale: true,
      next: { version: 5, data: { x: 5, fillColor: '#ff0000' } },
    });
  });

  it('baseVersion cũ, cùng trường: op đến sau thắng', () => {
    const afterA = nextOf(rect(), update({ x: 1 }, 3));
    expect(nextOf(afterA, update({ x: 2 }, 3)).data.x).toBe(2);
  });

  it('baseVersion lớn hơn version hiện có -> invalid_base_version', () => {
    expect(reasonOf(rect(), update({ x: 1 }, 4))).toBe('invalid_base_version');
  });

  it.each([
    ['không tồn tại -> not_found', undefined, 'not_found'],
    ['đã xóa -> deleted', rect({ isDeleted: true }), 'deleted'],
    ['đang khóa -> locked', rect({ locked: true }), 'locked'],
  ])('element %s', (_, cur, reason) =>
    expect(reasonOf(cur, update({ x: 1 }))).toBe(reason),
  );

  it('đang khóa: CHỈ { locked: false } được nhận; trộn { locked: false, x } bị chặn', () => {
    expect(
      nextOf(rect({ locked: true }), update({ locked: false })).locked,
    ).toBe(false);
    expect(
      reasonOf(rect({ locked: true }), update({ locked: false, x: 1 })),
    ).toBe('locked');
  });

  it('khóa / gán group được (cột meta)', () => {
    expect(
      nextOf(rect(), update({ locked: true, groupId: 'g1' })),
    ).toMatchObject({ locked: true, groupId: 'g1' });
  });

  it('patch rỗng -> empty_patch', () =>
    expect(reasonOf(rect(), update({}))).toBe('empty_patch'));

  it.each([
    ['cột hệ thống version', { version: 99 }],
    ['cột hệ thống isDeleted', { isDeleted: false }],
    ['cột hệ thống zIndex', { zIndex: 'zz' }],
    ['cột hệ thống id', { id: 'other' }],
    ['khóa lạ', { evil: 1 }],
    ['null ở trường số', { x: null }],
    ['chuỗi ở trường số', { x: '1' }],
    ['NaN', { x: NaN }],
    ['Infinity', { x: Infinity }],
    ['màu sai', { fillColor: 'red' }],
    ['locked không phải boolean', { locked: 'yes' }],
    ['trường của type khác (points cho rect)', { points: [[0, 0]] }],
  ])('patch %s -> invalid_patch', (_, patch) =>
    expect(reasonOf(rect(), update(patch))).toBe('invalid_patch'),
  );

  it('prototype pollution: __proto__ / constructor trong patch bị chặn, Object.prototype sạch', () => {
    for (const raw of [
      '{"__proto__":{"polluted":1}}',
      '{"constructor":{"prototype":{"polluted":1}}}',
    ]) {
      expect(reasonOf(rect(), update(JSON.parse(raw)))).toBe('invalid_patch');
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('merge NÔNG: patch points thay CẢ mảng, không trộn theo index', () => {
    const op = { ...update({ points: [[9, 9]] }), elementId: 'f1' };
    expect(nextOf(freedraw(), op).data.points).toEqual([[9, 9]]);
  });

  it('không sửa element đầu vào', () => {
    const cur = rect();
    const before = structuredClone(cur);
    applyOp(cur, update({ x: 5, locked: true }), ctx);
    expect(cur).toEqual(before);
  });
});

describe('applyOp: add', () => {
  it('element mới: version 1, zIndex do server cấp, chưa xóa, chưa khóa, group/frame null', () => {
    expect(nextOf(undefined, add())).toEqual({
      id: 'r1',
      type: 'rect',
      data: rect().data,
      zIndex: 'a0',
      version: 1,
      isDeleted: false,
      locked: false,
      groupId: null,
      frameId: null,
      updatedBy: 'u1',
    });
  });

  it.each([
    ['đang tồn tại', rect()],
    ['đã xóa mềm', rect({ isDeleted: true })],
  ])('trùng id element %s -> already_exists', (_, cur) =>
    expect(reasonOf(cur, add())).toBe('already_exists'),
  );
});

describe('applyOp: delete', () => {
  it('xóa mềm: isDeleted true, version + 1, GIỮ data để restore', () => {
    expect(nextOf(rect(), del())).toMatchObject({
      isDeleted: true,
      version: 4,
      updatedBy: 'u1',
      data: rect().data,
    });
  });

  it.each([
    ['không tồn tại -> not_found', undefined, 'not_found'],
    ['đã xóa -> deleted', rect({ isDeleted: true }), 'deleted'],
    ['đang khóa -> locked', rect({ locked: true }), 'locked'],
  ])('element %s', (_, cur, reason) =>
    expect(reasonOf(cur, del())).toBe(reason),
  );
});

describe('applyOp: restore', () => {
  it('khôi phục element đã xóa: isDeleted false, version + 1', () => {
    expect(nextOf(rect({ isDeleted: true }), restore())).toMatchObject({
      isDeleted: false,
      version: 4,
      updatedBy: 'u1',
    });
  });

  it.each([
    ['không tồn tại -> not_found', undefined, 'not_found'],
    ['chưa bị xóa -> not_deleted', rect(), 'not_deleted'],
  ])('element %s', (_, cur, reason) =>
    expect(reasonOf(cur, restore())).toBe(reason),
  );

  it('restore { clearSeq } không xử lý ở domain (service làm) -> unsupported_op', () => {
    expect(
      reasonOf(rect({ isDeleted: true }), {
        type: 'restore',
        opId: opId(),
        clearSeq: 3,
      }),
    ).toBe('unsupported_op');
  });
});

describe('applyOp: reorder', () => {
  const reorder = { type: 'reorder', opId: opId(), elementId: 'r1', position: 'front' } as const;
  const withZ = (cur: ElementState | undefined, reorderTo: string | null) => applyOp(cur, reorder, { ...ctx, reorderTo });

  it('đặt zIndex service đã tính, version + 1, KHÔNG đổi data; không mutate current', () => {
    const cur = rect();
    const before = structuredClone(cur);
    const r = withZ(cur, 'a5');
    expect(r).toMatchObject({ ok: true, next: { zIndex: 'a5', version: 4, updatedBy: 'u1', data: RECT_DATA } });
    expect(cur).toEqual(before);
  });

  it.each([
    ['không tồn tại', undefined, 'not_found'],
    ['đã xóa', rect({ isDeleted: true }), 'deleted'],
    ['đang khóa', rect({ locked: true }), 'locked'],
    ['đã ở trên cùng (service trả null)', rect(), 'no_change'],
  ])('%s -> %s', (_, cur, reason) => {
    const r = withZ(cur, null);
    expect(r.ok ? 'ok' : r.reason).toBe(reason);
  });
});

describe('applyOp: op domain không xử lý', () => {
  it('clear (service chạy updateMany) -> unsupported_op', () =>
    expect(reasonOf(rect(), { type: 'clear', opId: opId() })).toBe('unsupported_op'));
});
