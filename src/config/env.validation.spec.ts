import { envSchema } from './env.validation.js';

const base = {
  DATABASE_URL: 'postgresql://x@localhost:5433/db',
  CORS_ORIGIN: 'http://localhost:5173',
  REDIS_URL: 'redis://localhost:6379',
};

describe('envSchema', () => {
  it('ép PORT chuỗi thành số', () => {
    expect(envSchema.parse({ ...base, PORT: '4000' }).PORT).toBe(4000);
  });

  it('thiếu hoặc rỗng DATABASE_URL thì lỗi', () => {
    expect(envSchema.safeParse({ CORS_ORIGIN: base.CORS_ORIGIN }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, DATABASE_URL: '' }).success).toBe(false);
  });

  it('PORT rỗng hoặc không phải số thì lỗi', () => {
    expect(envSchema.safeParse({ ...base, PORT: '' }).success).toBe(false); // coerce('') = 0, bị .min(1) chặn
    expect(envSchema.safeParse({ ...base, PORT: 'abc' }).success).toBe(false);
  });
});
