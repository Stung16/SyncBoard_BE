import { createCommentSchema, updateCommentSchema } from './comment.dto.js';

const parentId = '0192f000-0000-7000-8000-000000000001';

describe('createCommentSchema', () => {
  it.each([
    ['gắn vào element', { body: 'Sửa màu', elementId: 'r1' }],
    ['gắn vào điểm', { body: 'Chỗ này', x: 10, y: -20 }],
    ['trả lời (không gắn)', { body: 'Ok', parentId }],
    ['kèm mentions', { body: 'Xem nhé', x: 0, y: 0, mentions: [parentId] }],
  ])('nhận: %s', (_, body) => expect(createCommentSchema.safeParse(body).success).toBe(true));

  it.each([
    ['không gắn vào đâu', { body: 'x' }],
    ['gắn cả element lẫn điểm', { body: 'x', elementId: 'r1', x: 1, y: 1 }],
    ['chỉ có x', { body: 'x', x: 1 }],
    ['trả lời mà vẫn gắn', { body: 'x', parentId, elementId: 'r1' }],
    ['body chỉ có dấu cách', { body: '   ', x: 0, y: 0 }],
    ['body 5.001 ký tự', { body: 'a'.repeat(5001), x: 0, y: 0 }],
    ['mention không phải uuid', { body: 'x', x: 0, y: 0, mentions: ['@An'] }],
    ['tọa độ Infinity', { body: 'x', x: Infinity, y: 0 }],
    ['khóa lạ (authorId)', { body: 'x', x: 0, y: 0, authorId: parentId }],
  ])('từ chối: %s', (_, body) => expect(createCommentSchema.safeParse(body).success).toBe(false));
});

describe('updateCommentSchema', () => {
  it('phải có ít nhất một trong body / resolved', () => {
    expect(updateCommentSchema.safeParse({}).success).toBe(false);
    expect(updateCommentSchema.safeParse({ resolved: true }).success).toBe(true);
    expect(updateCommentSchema.safeParse({ body: 'mới' }).success).toBe(true);
  });
});
