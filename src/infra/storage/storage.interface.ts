import type { Readable } from 'node:stream';

// Chỗ lưu file (ảnh upload). Hiện có ổ đĩa (LocalDiskStorage); sau này thêm S3/MinIO = thêm một class, service không đổi.
export const STORAGE = Symbol('STORAGE');

export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Readable>; // key không có -> ném lỗi
  delete(key: string): Promise<void>; // key không có -> không lỗi
}
