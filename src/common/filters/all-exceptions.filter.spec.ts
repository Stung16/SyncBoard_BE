import { BadRequestException, NotFoundException, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function run(exception: unknown) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: res.status.mock.calls[0]![0] as number, body: res.json.mock.calls[0]![0] as { errors: object[] } };
}

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta: { target: ['email'] } });

describe('AllExceptionsFilter', () => {
  it('AppError -> status + code + field do mình đặt', () => {
    expect(run(new AppError('EMAIL_TAKEN', 'email'))).toEqual({
      status: 409,
      body: { errors: [{ code: 'EMAIL_TAKEN', message: 'Email đã được sử dụng', field: 'email', details: undefined }] },
    });
  });

  it('Prisma đã biết -> status có nghĩa, không lộ meta (tên cột)', () => {
    expect(run(prismaError('P2002')).status).toBe(409);
    expect(run(prismaError('P2025')).status).toBe(404);
    expect(run(prismaError('P2003')).status).toBe(400);
    expect(JSON.stringify(run(prismaError('P2002')).body)).not.toContain('email');
  });

  it('Prisma chưa map / lỗi lạ -> 500 câu chung, không lộ message gốc', () => {
    for (const e of [prismaError('P1001'), new Error('SELECT * FROM users')]) {
      const { status, body } = run(e);
      expect(status).toBe(500);
      expect(body.errors).toEqual([{ code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống', field: null }]);
    }
  });

  it('HttpException của Nest -> code theo status', () => {
    expect(run(new UnauthorizedException()).body.errors[0]).toMatchObject({ code: 'UNAUTHORIZED', field: null });
    expect(run(new NotFoundException('Cannot GET /x')).body.errors[0]).toMatchObject({ code: 'NOT_FOUND', message: 'Cannot GET /x' });
  });

  it('lỗi pipe đã có mảng errors -> giữ nguyên', () => {
    const errors = [{ code: 'VALIDATION_ERROR', message: 'Too small', field: 'password' }];
    expect(run(new BadRequestException({ errors }))).toEqual({ status: 400, body: { errors } });
  });
});
