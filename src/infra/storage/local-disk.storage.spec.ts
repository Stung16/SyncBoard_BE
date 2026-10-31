import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDiskStorage } from './local-disk.storage.js';

describe('LocalDiskStorage', () => {
  let dir: string;
  let storage: LocalDiskStorage;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'syncboard-storage-'));
    storage = new LocalDiskStorage(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const readAll = async (key: string) => {
    const chunks: Buffer[] = [];
    for await (const c of await storage.read(key)) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };

  it('put tạo thư mục con, read đọc lại đúng nội dung, delete xóa (xóa lần 2 không lỗi)', async () => {
    await storage.put('board-1/a.png', Buffer.from('hello'), 'image/png');
    expect(await readFile(path.join(dir, 'board-1', 'a.png'), 'utf8')).toBe('hello');
    expect(await readAll('board-1/a.png')).toBe('hello');
    await storage.delete('board-1/a.png');
    await expect(storage.read('board-1/a.png')).rejects.toThrow();
    await expect(storage.delete('board-1/a.png')).resolves.toBeUndefined();
  });

  it.each(['../../x', '../x.png', '/etc/passwd', 'a/../../x', ''])('key "%s" thoát ra ngoài thư mục -> ném lỗi', async (key) => {
    await expect(storage.put(key, Buffer.from('x'), 'image/png')).rejects.toThrow('escapes upload dir');
    await expect(storage.read(key)).rejects.toThrow('escapes upload dir');
  });

  it('put trùng key -> lỗi, không ghi đè', async () => {
    await storage.put('b/a.png', Buffer.from('first'), 'image/png');
    await expect(storage.put('b/a.png', Buffer.from('second'), 'image/png')).rejects.toThrow();
    expect(await readAll('b/a.png')).toBe('first');
  });
});
