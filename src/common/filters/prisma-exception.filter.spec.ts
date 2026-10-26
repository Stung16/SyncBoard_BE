import type { ArgumentsHost, HttpServer } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaExceptionFilter } from './prisma-exception.filter.js';

function run(code: string) {
  const reply = vi.fn();
  const adapter = { reply, isHeadersSent: () => false, end: vi.fn() } as unknown as HttpServer;
  const host = { getArgByIndex: () => ({}), getArgs: () => [{}, {}] } as unknown as ArgumentsHost;
  const error = new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta: { target: ['email'] } });
  new PrismaExceptionFilter(adapter).catch(error, host);
  const [, body, status] = reply.mock.calls[0]!;
  return { body, status };
}

describe('PrismaExceptionFilter', () => {
  it('P2002 (trùng unique) -> 409', () => expect(run('P2002').status).toBe(409));
  it('P2025 (không tìm thấy) -> 404', () => expect(run('P2025').status).toBe(404));
  it('P2003 (sai khóa ngoại) -> 400', () => expect(run('P2003').status).toBe(400));
  it('mã khác -> 500', () => expect(run('P1001').status).toBe(500));
  it('không lộ meta (tên cột) ra client', () => expect(JSON.stringify(run('P2002').body)).not.toContain('email'));
});
