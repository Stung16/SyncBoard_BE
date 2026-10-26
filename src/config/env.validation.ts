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
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900), // 900s = 15 phút
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  APP_URL: z.url().default('http://localhost:5173'), // để dựng link trong email

  // Google OAuth: tùy chọn. Không đặt GOOGLE_CLIENT_ID thì tắt đăng nhập Google (route trả 404).
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CALLBACK_URL: z.url().default('http://localhost:3000/api/auth/google/callback'),
}).refine((e) => !e.GOOGLE_CLIENT_ID || !!e.GOOGLE_CLIENT_SECRET, {
  message: 'GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set',
  path: ['GOOGLE_CLIENT_SECRET'],
});
export type Env = z.infer<typeof envSchema>;
