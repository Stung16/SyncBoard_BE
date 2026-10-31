// Xô chứa tối đa `capacity` lượt, mỗi giây được nạp thêm `refillPerSec` lượt. Gửi tin = lấy 1 lượt; hết lượt = từ chối.
// Cho phép gửi dồn một chút (tới capacity) nhưng trung bình không vượt refillPerSec.
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = () => performance.now(), // test truyền đồng hồ giả
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  tryTake(): boolean {
    // Nạp "lười": không cần timer, tới lúc lấy mới tính đã trôi bao lâu
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) * this.refillPerSec) / 1000);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// 8.3: 30 lần/giây cho mỗi loại tin. Mỗi loại một xô riêng: spam con trỏ không chặn được SubmitOps.
const PER_SECOND = 30;
const KNOWN_EVENTS = new Set(['JoinBoard', 'SubmitOps', 'UpdateCursor', 'UpdateSelection', 'UpdateViewport', 'SendEphemeral', 'Ping']);
// Bị chặn quá 100 tin trong 10 giây = cố tình spam -> ngắt kết nối (8.3: "lần đầu bỏ qua, nhiều lần thì ngắt")
const MAX_DROPS = 100;
const DROP_WINDOW_MS = 10_000;

export type Verdict = 'ok' | 'drop' | 'kick';

// Một limiter cho mỗi socket (sống và chết cùng socket, không cần dọn).
export function createSocketLimiter(now: () => number = () => performance.now()) {
  const buckets = new Map<string, TokenBucket>();
  let windowStart = now();
  let drops = 0;

  return (event: string): Verdict => {
    const key = KNOWN_EVENTS.has(event) ? event : 'other'; // tên lạ dùng chung 1 xô: không cho tạo xô vô hạn
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = new TokenBucket(PER_SECOND, PER_SECOND, now)));
    if (bucket.tryTake()) return 'ok';

    const t = now();
    if (t - windowStart > DROP_WINDOW_MS) {
      windowStart = t;
      drops = 0;
    }
    return ++drops > MAX_DROPS ? 'kick' : 'drop';
  };
}
