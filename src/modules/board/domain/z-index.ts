import { generateKeyBetween } from 'fractional-indexing';

export type ReorderPosition = 'front' | 'back' | 'forward' | 'backward';

// Hàng xóm service đọc từ DB (so theo byte, cột COLLATE "C"):
// - near: element CHƯA XÓA gần nhất theo hướng di chuyển (trên với front/forward, dưới với back/backward). null = đã ở đầu đó.
// - far:  front -> zIndex lớn nhất cả bảng; back -> nhỏ nhất; forward -> zIndex kế tiếp NGAY TRÊN near; backward -> ngay dưới near.
//         Tính cả element đã xóa: khóa mới không bao giờ trùng khóa của element xóa mềm (restore xong thứ tự vẫn rõ ràng,
//         và generateKeyBetween ném lỗi khi hai đầu bằng nhau).
export type ReorderNeighbors = { near: string | null; far: string | null };

// zIndex mới, hoặc null = không đổi gì (đã trên cùng mà bấm "lên trên").
export function reorderZIndex(position: ReorderPosition, { near, far }: ReorderNeighbors): string | null {
  if (near === null) return null;
  switch (position) {
    case 'front':
      return generateKeyBetween(far, null);
    case 'back':
      return generateKeyBetween(null, far);
    case 'forward':
      return generateKeyBetween(near, far); // chen vào giữa near và cái ngay trên nó = vượt lên đúng 1 bậc
    case 'backward':
      return generateKeyBetween(far, near);
  }
}
