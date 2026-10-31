import { submitOpsSchema } from './op.dto.js';

const opId = () => crypto.randomUUID();
// Một op add freedraw hợp lệ; truyền `data` để ghi đè từng trường khi muốn làm hỏng
const addFreedraw = (data: Record<string, unknown> = {}) => ({
  type: 'add',
  opId: opId(),
  element: {
    id: 'el_1',
    type: 'freedraw',
    data: {
      x: 0,
      y: 0,
      points: [
        [0, 0],
        [5, 5],
      ],
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 1,
      ...data,
    },
  },
});
const rectData = {
  x: 1,
  y: 1,
  width: 10,
  height: 10,
  angle: 0,
  strokeColor: '#000000',
  fillColor: 'transparent',
  strokeWidth: 1,
  strokeStyle: 'solid',
  opacity: 1,
};

describe('submitOpsSchema', () => {
  it.each([
    ['freedraw hợp lệ', { ops: [addFreedraw()] }],
    [
      'rect hợp lệ',
      {
        ops: [
          {
            type: 'add',
            opId: opId(),
            element: { id: 'r1', type: 'rect', data: rectData },
          },
        ],
      },
    ],
    [
      'update',
      {
        ops: [
          {
            type: 'update',
            opId: opId(),
            elementId: 'el_1',
            baseVersion: 1,
            patch: { x: 5 },
          },
        ],
      },
    ],
    ['delete', { ops: [{ type: 'delete', opId: opId(), elementId: 'el_1' }] }],
    [
      'restore { elementId }',
      { ops: [{ type: 'restore', opId: opId(), elementId: 'el_1' }] },
    ],
    [
      'restore { clearSeq }',
      { ops: [{ type: 'restore', opId: opId(), clearSeq: 3 }] },
    ],
    [
      'reorder',
      {
        ops: [
          {
            type: 'reorder',
            opId: opId(),
            elementId: 'el_1',
            position: 'front',
          },
        ],
      },
    ],
    ['clear một mình', { ops: [{ type: 'clear', opId: opId() }] }],
    [
      '100 op (đúng giới hạn)',
      { ops: Array.from({ length: 100 }, () => addFreedraw()) },
    ],
  ])('qua: %s', (_, input) =>
    expect(submitOpsSchema.safeParse(input).success).toBe(true),
  );

  it.each([
    // [tên, input, path lỗi mong đợi] -> kiểm cả CHỖ lỗi, không chỉ "có lỗi"
    [
      'element type lạ',
      {
        ops: [
          {
            ...addFreedraw(),
            element: { ...addFreedraw().element, type: 'script' },
          },
        ],
      },
      'ops.0.element.type',
    ],
    ['NaN', { ops: [addFreedraw({ x: NaN })] }, 'ops.0.element.data.x'],
    [
      'Infinity',
      { ops: [addFreedraw({ x: Infinity })] },
      'ops.0.element.data.x',
    ],
    [
      'null ở chỗ cần số (JSON biến NaN thành null)',
      { ops: [addFreedraw({ x: null })] },
      'ops.0.element.data.x',
    ],
    [
      'tọa độ quá lớn',
      { ops: [addFreedraw({ x: 1e9 })] },
      'ops.0.element.data.x',
    ],
    [
      '5001 điểm',
      {
        ops: [
          addFreedraw({ points: Array.from({ length: 5001 }, () => [0, 0]) }),
        ],
      },
      'ops.0.element.data.points',
    ],
    [
      'khóa lạ trong data',
      { ops: [addFreedraw({ evil: 1 })] },
      'ops.0.element.data',
    ],
    [
      'màu sai',
      { ops: [addFreedraw({ strokeColor: 'red;}' })] },
      'ops.0.element.data.strokeColor',
    ],
    [
      'khóa lạ cấp op',
      {
        ops: [{ type: 'delete', opId: opId(), elementId: 'a', role: 'OWNER' }],
      },
      'ops.0',
    ],
    [
      '101 op',
      { ops: Array.from({ length: 101 }, () => addFreedraw()) },
      'ops',
    ],
    ['lô rỗng', { ops: [] }, 'ops'],
    [
      'clear kèm op khác',
      { ops: [{ type: 'clear', opId: opId() }, addFreedraw()] },
      'ops',
    ],
    [
      'restore thiếu cả 2',
      { ops: [{ type: 'restore', opId: opId() }] },
      'ops.0',
    ],
    [
      'restore có cả 2',
      { ops: [{ type: 'restore', opId: opId(), elementId: 'a', clearSeq: 3 }] },
      'ops.0',
    ],
    ['op type lạ', { ops: [{ type: 'bogus', opId: opId() }] }, 'ops.0.type'],
    [
      'opId không phải uuid',
      { ops: [{ type: 'delete', opId: 'x', elementId: 'a' }] },
      'ops.0.opId',
    ],
    [
      'baseVersion âm',
      {
        ops: [
          {
            type: 'update',
            opId: opId(),
            elementId: 'a',
            baseVersion: -1,
            patch: {},
          },
        ],
      },
      'ops.0.baseVersion',
    ],
    ['mảng trần (không bọc ops)', [addFreedraw()], ''],
  ])('chặn: %s', (_, input, path) => {
    const r = submitOpsSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain(path);
  });

  it('patch có __proto__ LỌT qua schema (domain apply-op phải chặn bằng allowlist)', () => {
    const raw = JSON.parse(
      `{"ops":[{"type":"update","opId":"${opId()}","elementId":"a","baseVersion":1,"patch":{"constructor":{"x":1}}}]}`,
    );
    expect(submitOpsSchema.safeParse(raw).success).toBe(true);
  });
});

describe('element text / sticky', () => {
  const textData = { x: 0, y: 0, width: 200, text: 'Xin chào', fontSize: 16, color: '#1e1e1e', align: 'left' };
  const stickyData = { x: 0, y: 0, width: 150, height: 150, text: '', color: '#ffec99' };
  const addEl = (type: string, data: Record<string, unknown>) => ({
    ops: [{ type: 'add', opId: opId(), element: { id: 't1', type, data } }],
  });

  it.each([
    ['text hợp lệ', addEl('text', textData)],
    ['text rỗng (vừa tạo ô)', addEl('text', { ...textData, text: '' })],
    ['text đủ 10.000 ký tự', addEl('text', { ...textData, text: 'a'.repeat(10_000) })],
    ['sticky hợp lệ', addEl('sticky', stickyData)],
  ])('nhận: %s', (_name, body) => {
    expect(submitOpsSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['text 10.001 ký tự', addEl('text', { ...textData, text: 'a'.repeat(10_001) })],
    ['align lạ', addEl('text', { ...textData, align: 'justify' })],
    ['fontSize 0', addEl('text', { ...textData, fontSize: 0 })],
    ['text thiếu fontSize', addEl('text', { x: 0, y: 0, width: 1, text: '', color: '#000000', align: 'left' })],
    ['sticky có khóa lạ', addEl('sticky', { ...stickyData, fontSize: 12 })],
    ['sticky màu rác', addEl('sticky', { ...stickyData, color: 'red; drop table' })],
    ['dữ liệu text gắn type sticky', addEl('sticky', textData)],
  ])('từ chối: %s', (_name, body) => {
    expect(submitOpsSchema.safeParse(body).success).toBe(false);
  });
});

describe('element line / arrow / frame', () => {
  const arrowData = {
    x: 0,
    y: 0,
    points: [
      [0, 0],
      [100, 50],
    ],
    strokeColor: '#1e1e1e',
    strokeWidth: 2,
    strokeStyle: 'solid',
    opacity: 1,
    startBinding: { elementId: 'r1' },
    endBinding: null,
    arrowhead: 'arrow',
  };
  const frameData = { x: 0, y: 0, width: 800, height: 600, name: 'Sprint 12' };
  const addEl = (type: string, data: Record<string, unknown>) => ({
    ops: [{ type: 'add', opId: opId(), element: { id: 'l1', type, data } }],
  });

  it.each([
    ['arrow dính vào hình ở đầu', addEl('arrow', arrowData)],
    ['line không dính, không đầu mũi tên', addEl('line', { ...arrowData, startBinding: null, arrowhead: 'none' })],
    ['frame', addEl('frame', frameData)],
    ['frame tên rỗng', addEl('frame', { ...frameData, name: '' })],
  ])('nhận: %s', (_name, body) => {
    expect(submitOpsSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['arrow 1 điểm', addEl('arrow', { ...arrowData, points: [[0, 0]] })],
    ['arrow thiếu endBinding (phải gửi null)', addEl('arrow', { ...arrowData, endBinding: undefined })],
    ['binding có khóa lạ', addEl('arrow', { ...arrowData, startBinding: { elementId: 'r1', x: 1 } })],
    ['binding là chuỗi', addEl('arrow', { ...arrowData, startBinding: 'r1' })],
    ['arrowhead lạ', addEl('arrow', { ...arrowData, arrowhead: 'heart' })],
    ['frame tên 101 ký tự', addEl('frame', { ...frameData, name: 'x'.repeat(101) })],
    ['frame thiếu height', addEl('frame', { x: 0, y: 0, width: 1, name: '' })],
  ])('từ chối: %s', (_name, body) => {
    expect(submitOpsSchema.safeParse(body).success).toBe(false);
  });
});
