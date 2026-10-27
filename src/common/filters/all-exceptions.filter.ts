import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';

export interface ApiError {
  code: string;
  message: string;
  field: string | null;
  details?: Record<string, unknown>;
}

const STATUS_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

// Lưới an toàn cho chỗ quên tự bắt; đường chính là service ném AppError. Không đưa `meta` (tên cột) ra client.
const PRISMA_ERROR: Record<string, { status: number; code: string; message: string }> = {
  P2002: { status: 409, code: 'CONFLICT', message: 'Dữ liệu đã tồn tại' },
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu' },
  P2003: { status: 400, code: 'BAD_REFERENCE', message: 'Dữ liệu liên quan không tồn tại' },
};

// Mọi lỗi HTTP ra cùng một dạng: { errors: [{ code, message, field, details? }] }.
// Đăng ký bằng useGlobalFilters nên chỉ chạy cho HTTP; gateway dùng WsExceptionFilter.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const { status, errors } = this.toApi(exception);
    host.switchToHttp().getResponse<Response>().status(status).json({ errors });
  }

  private toApi(e: unknown): { status: number; errors: ApiError[] } {
    if (e instanceof AppError) {
      return { status: e.status, errors: [{ code: e.code, message: e.message, field: e.field ?? null, details: e.details }] };
    }

    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR[e.code];
      if (mapped) return { status: mapped.status, errors: [{ code: mapped.code, message: mapped.message, field: null }] };
    }

    if (e instanceof HttpException) {
      const status = e.getStatus();
      const body = e.getResponse() as string | { message?: string | string[]; errors?: ApiError[] };
      if (typeof body === 'object' && Array.isArray(body.errors)) return { status, errors: body.errors }; // từ pipe Zod, đã đúng dạng
      const raw = typeof body === 'string' ? body : (body.message ?? e.message);
      const message = Array.isArray(raw) ? raw.join('; ') : raw; // new BadRequestException(['a', 'b']) -> message là mảng
      return { status, errors: [{ code: STATUS_CODE[status] ?? 'HTTP_ERROR', message, field: null }] };
    }
    // Lỗi lạ (bug, mất kết nối DB, Prisma chưa map): log đủ ở server, client chỉ thấy câu chung
    this.logger.error(e instanceof Error ? e.stack : String(e));
    return { status: 500, errors: [{ code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống', field: null }] };
  }
}
