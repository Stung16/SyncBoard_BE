import { generateKeyBetween } from 'fractional-indexing';
import { reorderZIndex } from './z-index.js';

// So theo byte như Postgres COLLATE "C" (localeCompare sẽ sai: "Zz" < "a0" theo byte)
const byteSort = (keys: string[]) => [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe('reorderZIndex', () => {
  it('không có hàng xóm theo hướng đó (đã trên cùng / dưới cùng) -> null', () => {
    for (const p of ['front', 'back', 'forward', 'backward'] as const) expect(reorderZIndex(p, { near: null, far: 'a5' })).toBeNull();
  });

  it('front -> trên khóa lớn nhất; back -> dưới khóa nhỏ nhất', () => {
    expect(reorderZIndex('front', { near: 'a1', far: 'a5' })! > 'a5').toBe(true);
    expect(reorderZIndex('back', { near: 'a1', far: 'a0' })! < 'a0').toBe(true);
  });

  it('forward chen giữa near và cái ngay trên; không có gì trên near -> chỉ cần trên near', () => {
    const k = reorderZIndex('forward', { near: 'a1', far: 'a2' })!;
    expect(k > 'a1' && k < 'a2').toBe(true);
    expect(reorderZIndex('forward', { near: 'a1', far: null })! > 'a1').toBe(true);
    const b = reorderZIndex('backward', { near: 'a1', far: 'a0' })!;
    expect(b > 'a0' && b < 'a1').toBe(true);
  });

  it('1.000 lần front liên tiếp -> tăng ngặt (khớp cả sort theo byte)', () => {
    let top = 'a0';
    const keys = [top];
    for (let i = 0; i < 1000; i++) {
      top = reorderZIndex('front', { near: 'x', far: top })!;
      keys.push(top);
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i]! > keys[i - 1]!).toBe(true);
    expect(byteSort(keys)).toEqual(keys);
  });

  it('100 lần forward vào cùng một khe vẫn tăng ngặt và nằm trong khe', () => {
    const [lo, hi] = ['a0', 'a1'];
    let near = lo;
    for (let i = 0; i < 100; i++) {
      const k = reorderZIndex('forward', { near, far: hi })!;
      expect(k > near && k < hi).toBe(true);
      near = k;
    }
  });

  it('khóa có chữ hoa và chữ thường ("Zz" < "a0" theo byte) vẫn đúng thứ tự', () => {
    const low = generateKeyBetween(null, 'a0'); // "Zz"
    expect(low).toBe('Zz');
    const k = reorderZIndex('forward', { near: low, far: 'a0' })!;
    expect(byteSort([k, 'a0', low])).toEqual([low, k, 'a0']);
  });
});
