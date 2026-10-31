import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { io, type Socket } from 'socket.io-client';
import { PrismaService } from '../src/infra/database/prisma.service.js';

// User thật trong DB (board_members cần khóa ngoại) + access token ký bằng đúng secret của app.
export async function createUser(app: INestApplication, opts: { expiresIn?: number } = {}) {
  const user = await app.get(PrismaService).user.create({
    data: { email: `${randomUUID()}@e2e.test`, displayName: 'E2E', emailVerifiedAt: new Date() },
  });
  const token = await app.get(JwtService).signAsync({ sub: user.id }, opts.expiresIn ? { expiresIn: opts.expiresIn } : {});
  return { id: user.id, email: user.email, token };
}

// editorIds: thêm sẵn làm EDITOR (người không phải thành viên giờ không vào được bảng)
export function createBoard(app: INestApplication, ownerId: string, editorIds: string[] = []) {
  const members = [{ userId: ownerId, role: 'OWNER' as const }, ...editorIds.map((userId) => ({ userId, role: 'EDITOR' as const }))];
  return app.get(PrismaService).board.create({ data: { ownerId, members: { create: members } } });
}

export async function connect(app: INestApplication, token?: string): Promise<Socket> {
  const client = io(await app.getUrl(), { transports: ['websocket'], forceNew: true, auth: token ? { token } : {} });
  await new Promise<void>((ok, fail) => {
    client.once('connect', ok);
    client.once('connect_error', fail);
  });
  return client;
}

export const joinPayload = (boardId: string) => ({ boardId, displayName: 'E2E', clientId: randomUUID() });

export const nextEvent = <T = unknown>(client: Socket, event: string) => new Promise<T>((r) => client.once(event, r));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
