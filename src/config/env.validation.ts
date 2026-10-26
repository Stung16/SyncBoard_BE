import { z } from 'zod';

export const envSchema = z.object({          // z.object, KHÔNG phải z.strictObject (xem bẫy)
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),   // env luôn là chuỗi
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().min(1),            // "http://localhost:5173,http://..."
});
export type Env = z.infer<typeof envSchema>;
