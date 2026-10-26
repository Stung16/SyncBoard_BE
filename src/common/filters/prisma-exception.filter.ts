import { ArgumentsHost, BadRequestException, Catch, ConflictException, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '../../generated/prisma/client.js';

// Đổi lỗi Prisma đã biết thành HTTP status có nghĩa; lỗi khác để Nest trả 500.
// Không đưa `meta` (tên cột, constraint) ra client. Chỉ áp cho HTTP: global filter không chạy với gateway.
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  override catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    super.catch(toHttp(error) ?? error, host);
  }
}

function toHttp(error: Prisma.PrismaClientKnownRequestError) {
  switch (error.code) {
    case 'P2002':
      return new ConflictException('Resource already exists'); // trùng unique
    case 'P2025':
      return new NotFoundException('Resource not found'); // update/delete bản ghi không tồn tại
    case 'P2003':
      return new BadRequestException('Related resource does not exist'); // sai khóa ngoại
    default:
      return undefined;
  }
}
