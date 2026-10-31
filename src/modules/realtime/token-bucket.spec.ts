import { createSocketLimiter, TokenBucket } from './token-bucket.js';

// Đồng hồ giả: test tự tua thời gian, không phải sleep
const fakeClock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('TokenBucket', () => {
  it('lấy liên tục được đúng capacity lần, lần tiếp theo bị từ chối', () => {
    const clock = fakeClock();
    const b = new TokenBucket(5, 5, clock.now);
    expect(Array.from({ length: 5 }, () => b.tryTake())).toEqual([true, true, true, true, true]);
    expect(b.tryTake()).toBe(false);
  });

  it('tua 1 giây -> có lại refillPerSec lượt; tua 200ms -> 1 lượt (5/s)', () => {
    const clock = fakeClock();
    const b = new TokenBucket(5, 5, clock.now);
    for (let i = 0; i < 5; i++) b.tryTake();
    clock.advance(200);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    clock.advance(1000);
    expect(Array.from({ length: 6 }, () => b.tryTake())).toEqual([true, true, true, true, true, false]);
  });

  it('nghỉ lâu cũng không tích quá capacity', () => {
    const clock = fakeClock();
    const b = new TokenBucket(3, 3, clock.now);
    clock.advance(60_000);
    expect(Array.from({ length: 4 }, () => b.tryTake())).toEqual([true, true, true, false]);
  });

  it('gửi đều đúng tốc độ thì không bao giờ bị từ chối', () => {
    const clock = fakeClock();
    const b = new TokenBucket(30, 30, clock.now);
    for (let i = 0; i < 300; i++) {
      clock.advance(1000 / 30);
      expect(b.tryTake()).toBe(true);
    }
  });
});

describe('createSocketLimiter', () => {
  it('30 tin/giây mỗi loại; mỗi loại một xô riêng', () => {
    const clock = fakeClock();
    const limit = createSocketLimiter(clock.now);
    for (let i = 0; i < 30; i++) expect(limit('UpdateCursor')).toBe('ok');
    expect(limit('UpdateCursor')).toBe('drop');
    expect(limit('SubmitOps')).toBe('ok'); // spam con trỏ không chặn SubmitOps
  });

  it('tên sự kiện lạ dùng chung một xô', () => {
    const clock = fakeClock();
    const limit = createSocketLimiter(clock.now);
    for (let i = 0; i < 30; i++) expect(limit(`junk${i}`)).toBe('ok');
    expect(limit('junk-new')).toBe('drop');
  });

  it('bị chặn quá 100 tin trong 10 giây -> kick', () => {
    const clock = fakeClock();
    const limit = createSocketLimiter(clock.now);
    for (let i = 0; i < 30; i++) limit('UpdateCursor');
    const verdicts = Array.from({ length: 101 }, () => limit('UpdateCursor'));
    expect(verdicts.slice(0, 100).every((v) => v === 'drop')).toBe(true);
    expect(verdicts[100]).toBe('kick');
  });

  it('bị chặn rải rác (qua cửa sổ 10 giây mới) -> bộ đếm reset, không kick', () => {
    const clock = fakeClock();
    const limit = createSocketLimiter(clock.now);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 30; i++) limit('UpdateCursor');
      for (let i = 0; i < 60; i++) expect(limit('UpdateCursor')).toBe('drop');
      clock.advance(11_000);
    }
  });
});
