import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { RedisClient } from './redis.module.js';

const toSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

// Bộ đếm dùng chung cho mọi node (storage mặc định của throttler nằm trong RAM: N node = giới hạn x N).
// shortcut: cửa sổ cố định (cho phép dồn ~2x ở ranh giới cửa sổ); cần mượt hơn thì đổi sang cửa sổ trượt (sorted set).
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: RedisClient) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    const hitKey = `rl:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;
    try {
      // 1. Đang bị khóa -> trả luôn, KHÔNG đếm thêm
      const blockMs = await this.redis.pTTL(blockKey);
      if (blockMs > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: toSeconds(blockMs),
          isBlocked: true,
          timeToBlockExpire: toSeconds(blockMs),
        };
      }

      // 2. Đếm: INCR + đặt hạn sống CHỈ lần đầu (NX) + hỏi còn bao lâu; một khối MULTI -> không bao giờ có key thiếu TTL
      const [totalHits, , hitMs] = await this.redis
        .multi()
        .incr(hitKey)
        .pExpire(hitKey, ttl, 'NX')
        .pTTL(hitKey)
        .execTyped();
      if (totalHits <= limit) {
        return {
          totalHits,
          timeToExpire: toSeconds(hitMs),
          isBlocked: false,
          timeToBlockExpire: 0,
        };
      }

      // 3. Vượt giới hạn. blockDuration = 0 -> không khóa riêng, chỉ chờ hết cửa sổ
      if (blockDuration <= 0) {
        return {
          totalHits,
          timeToExpire: toSeconds(hitMs),
          isBlocked: true,
          timeToBlockExpire: toSeconds(hitMs),
        };
      }
      await this.redis.set(blockKey, '1', {
        expiration: { type: 'PX', value: blockDuration },
      });
      return {
        totalHits,
        timeToExpire: toSeconds(hitMs),
        isBlocked: true,
        timeToBlockExpire: toSeconds(blockDuration),
      };
    } catch (err) {
      // Fail-open: Redis lỗi thì cho request qua (kèm log) thay vì làm sập mọi route.
      this.logger.warn(`Rate limit bỏ qua vì Redis lỗi: ${String(err)}`);
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
