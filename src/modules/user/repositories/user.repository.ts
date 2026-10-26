import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infra/database/prisma.service.js';

// Chỉ chứa query bảng users. Không logic nghiệp vụ, không ném HttpException.
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  // TODO(bạn code): findByEmail, findById (omit passwordHash), create, update...
}
