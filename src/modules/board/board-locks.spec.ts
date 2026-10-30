import { BoardLocks } from './board-locks.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BoardLocks', () => {
  let locks: BoardLocks;
  beforeEach(() => (locks = new BoardLocks()));

  it('cùng một bảng: việc sau chỉ bắt đầu khi việc trước xong (không xen kẽ)', async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`start${name}`);
      await sleep(ms); // chỗ await = chỗ việc khác có thể chen vào nếu không có khóa
      log.push(`end${name}`);
    };
    await Promise.all([
      locks.run('b1', job('1', 20)),
      locks.run('b1', job('2', 0)),
    ]);
    expect(log).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('cùng một bảng: 100 việc chạy song song vẫn lần lượt -> "seq" liên tục, không trùng', async () => {
    let lastSeq = 0;
    const seqs: number[] = [];
    // Mô phỏng đọc last_seq -> await -> ghi last_seq + 1. Không có khóa thì nhiều việc cùng đọc một giá trị.
    const allocate = async () => {
      const read = lastSeq;
      await sleep(0);
      lastSeq = read + 1;
      seqs.push(lastSeq);
    };
    await Promise.all(
      Array.from({ length: 100 }, () => locks.run('b1', allocate)),
    );
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it('khác bảng: chạy song song, không chờ nhau', async () => {
    const start = performance.now();
    await Promise.all([
      locks.run('b1', () => sleep(50)),
      locks.run('b2', () => sleep(50)),
    ]);
    expect(performance.now() - start).toBeLessThan(90); // nối đuôi thì phải >= 100ms
  });

  it('việc trước ném lỗi: run đó reject đúng lỗi, việc sau vẫn chạy', async () => {
    const boom = new Error('boom');
    const first = locks.run('b1', async () => {
      throw boom;
    });
    const second = locks.run('b1', async () => 'ok');
    await expect(first).rejects.toBe(boom);
    await expect(second).resolves.toBe('ok');
  });

  it('trả về đúng kết quả của work', async () => {
    await expect(locks.run('b1', async () => 42)).resolves.toBe(42);
  });

  it('hết việc thì xóa key khỏi Map (không rò bộ nhớ), kể cả khi có lỗi', async () => {
    await Promise.allSettled([
      locks.run('b1', () => sleep(5)),
      locks.run('b1', async () => {
        throw new Error('x');
      }),
      locks.run('b2', () => sleep(5)),
    ]);
    expect(locks.size()).toBe(0);
  });

  it('1.000 việc nối đuôi trên một bảng chạy đúng thứ tự gửi', async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        locks.run('b1', async () => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(locks.size()).toBe(0);
  });

  it('drain: chờ mọi việc đang chạy xong', async () => {
    let done = false;
    void locks.run('b1', async () => {
      await sleep(20);
      done = true;
    });
    await locks.drain();
    expect(done).toBe(true);
  });
});
