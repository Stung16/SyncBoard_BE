import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { UserRepository } from '../repositories/user.repository.js';

@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}

  // Một chỗ duy nhất chuẩn hóa email: "An@Mail.com " và "an@mail.com" là cùng một người.
  normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  findByEmail(email: string) {
    return this.users.findByEmail(this.normalizeEmail(email));
  }

  create(
    data: { email: string; passwordHash: string | null; displayName: string },
    db?: Prisma.TransactionClient,
  ) {
    return this.users.create(
      { ...data, email: this.normalizeEmail(data.email) },
      db,
    );
  }

  async getById(id: string) {
    const user = await this.users.findById(id);
    if (!user) throw new AppError('USER_NOT_FOUND'); // token còn hạn nhưng tài khoản đã bị xóa
    return user;
  }

  markEmailVerified(id: string, db?: Prisma.TransactionClient) {
    return this.users.markEmailVerified(id, db);
  }

  setPassword(id: string, passwordHash: string, db?: Prisma.TransactionClient) {
    return this.users.setPassword(id, passwordHash, db);
  }
}
