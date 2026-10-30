import { colorFor, listMembers, type Member } from './presence-tracker.js';

const m = (userId: string, clientId = `${userId}-tab`): Member => ({ userId, clientId, displayName: userId, color: colorFor(userId) });

describe('presence', () => {
  it('colorFor: cùng userId -> cùng màu, luôn là mã hex', () => {
    expect(colorFor('u1')).toBe(colorFor('u1'));
    expect(colorFor('0192f000-0000-7000-8000-000000000001')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('colorFor: nhiều user được rải ra nhiều màu (không dồn một màu)', () => {
    const colors = new Set(Array.from({ length: 50 }, (_, i) => colorFor(`user-${i}`)));
    expect(colors.size).toBeGreaterThan(4);
  });

  it('listMembers: 2 tab của cùng người -> 1 dòng; người khác giữ nguyên', () => {
    const list = listMembers([m('a', 'tab1'), m('a', 'tab2'), m('b')]);
    expect(list.map((x) => x.userId)).toEqual(['a', 'b']);
  });

  it('listMembers: rỗng -> rỗng', () => {
    expect(listMembers([])).toEqual([]);
  });
});
