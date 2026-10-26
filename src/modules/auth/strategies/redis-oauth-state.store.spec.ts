import type { RedisClient } from '../../../infra/redis/redis.module.js';
import { RedisOAuthStateStore } from './redis-oauth-state.store.js';

function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    client: {
      set: vi.fn(async (k: string, v: string) => void data.set(k, v)),
      getDel: vi.fn(async (k: string) => {
        const v = data.get(k) ?? null;
        data.delete(k);
        return v;
      }),
    } as unknown as RedisClient,
  };
}

const call = <T extends unknown[]>(fn: (cb: (...a: T) => void) => void) => new Promise<T>((r) => fn((...a) => r(a)));

describe('RedisOAuthStateStore', () => {
  it('giữ đúng số tham số mà passport-oauth2 dùng để chọn chế độ PKCE', () => {
    const s = new RedisOAuthStateStore(fakeRedis().client, 'p');
    expect(s.store.length).toBe(5); // 5 = (req, verifier, state, meta, cb)
    expect(s.verify.length).toBe(3); // 3 = (req, state, cb)
  });

  it('store lưu verifier theo handle ngẫu nhiên, có TTL', async () => {
    const r = fakeRedis();
    const [err, handle] = await call<[Error | null, string?]>((cb) =>
      new RedisOAuthStateStore(r.client, 'p').store({}, 'verifier-1', undefined, {}, cb),
    );
    expect(err).toBeNull();
    expect(handle).toMatch(/^[\w-]{32}$/);
    expect(r.data.get(`p:${handle}`)).toBe('verifier-1');
    expect(r.client.set).toHaveBeenCalledWith(`p:${handle}`, 'verifier-1', { expiration: { type: 'EX', value: 600 } });
  });

  it('verify trả verifier đúng một lần (lần hai bị từ chối: chống replay)', async () => {
    const r = fakeRedis();
    r.data.set('p:h1', 'verifier-1');
    const store = new RedisOAuthStateStore(r.client, 'p');
    expect((await call((cb) => store.verify({}, 'h1', cb)))[1]).toBe('verifier-1');
    expect((await call((cb) => store.verify({}, 'h1', cb)))[1]).toBe(false);
  });

  it('state thiếu hoặc lạ -> false', async () => {
    const store = new RedisOAuthStateStore(fakeRedis().client, 'p');
    expect((await call((cb) => store.verify({}, undefined, cb)))[1]).toBe(false);
    expect((await call((cb) => store.verify({}, 'nope', cb)))[1]).toBe(false);
  });
});
