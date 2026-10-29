import { z } from 'zod';

export const loginSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(128),
});
export type LoginDto = z.infer<typeof loginSchema>;
