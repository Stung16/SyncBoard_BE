import { z } from 'zod';

export const verifyEmailSchema = z.object({ token: z.string().min(1).max(256) });
export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>;
