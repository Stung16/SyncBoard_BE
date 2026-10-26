import { z } from 'zod';

export const joinBoardSchema = z.strictObject({
  boardId: z.uuid(),
  displayName: z.string().trim().min(1).max(50),
  clientId: z.uuid(),
  lastSeq: z.int().min(0).optional(),
  shareToken: z.string().max(100).optional(),
});
export type JoinBoardDto = z.infer<typeof joinBoardSchema>;
