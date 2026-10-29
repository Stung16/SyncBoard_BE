import { z } from 'zod';

export const resendVerificationSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});
export type ResendVerificationDto = z.infer<typeof resendVerificationSchema>;
