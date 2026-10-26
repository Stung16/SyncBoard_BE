import { z } from 'zod';

export const envSchema = z.object({
  // z.object, KHÔNG phải z.strictObject (xem bẫy)
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000), // env luôn là chuỗi
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().min(1), // "http://localhost:5173,http://..."
  REDIS_URL: z.string().min(1), // "redis://localhost:6379"

  JWT_ACCESS_SECRET: z.string().min(32), // chuỗi ngẫu nhiên dài; KHÔNG commit
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  APP_URL: z.url().default('http://localhost:5173'), // để dựng link trong email
});
export type Env = z.infer<typeof envSchema>;
