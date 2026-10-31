import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Storage } from './storage.interface.js';

export class LocalDiskStorage implements Storage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  // Key do server sinh (boardId/uuid.png) nhưng vẫn chặn "../": lỡ sau này ai ghép key từ input thì không ghi ra ngoài thư mục.
  private pathOf(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Storage key escapes upload dir: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer, _contentType: string) {
    const full = this.pathOf(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { flag: 'wx' }); // wx: key đã có thì lỗi, không ghi đè ảnh khác
  }

  async read(key: string): Promise<Readable> {
    const full = this.pathOf(key);
    await stat(full); // file mất -> lỗi NGAY (trước khi trả header), không phải lỗi giữa chừng lúc stream
    return createReadStream(full);
  }

  async delete(key: string) {
    await rm(this.pathOf(key), { force: true });
  }
}
