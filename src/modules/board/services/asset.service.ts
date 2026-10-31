import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { API_PREFIX } from '../../../config/api-prefix.js';
import { STORAGE, type Storage } from '../../../infra/storage/storage.interface.js';
import { AssetRepository } from '../repositories/asset.repository.js';
import { SharingService } from './sharing.service.js';

// Phần của file multer mà service dùng (không cài @types/multer chỉ để lấy kiểu này)
export type UploadedImage = { buffer: Buffer; mimetype: string; size: number };

// Đuôi file do SERVER chọn từ loại đã dò bằng magic byte; không bao giờ dùng originalname của client
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

@Injectable()
export class AssetService {
  constructor(
    private readonly assets: AssetRepository,
    private readonly sharing: SharingService,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  // UC 2.10: ảnh đi REST, không đi socket. Client nhận assetId rồi gửi op add { type: 'image', data: { assetId } }.
  async upload(boardId: string, userId: string, file: UploadedImage) {
    await this.sharing.authorize(boardId, userId, 'submitOps'); // chỉ ai vẽ được mới upload được
    const ext = EXT[file.mimetype];
    if (!ext) throw new AppError('INVALID_IMAGE', 'file'); // FileTypeValidator đã chặn; giữ lại phòng khi đổi allowlist

    const id = randomUUID();
    const storageKey = `${boardId}/${id}.${ext}`;
    await this.storage.put(storageKey, file.buffer, file.mimetype);
    try {
      await this.assets.create({
        id,
        boardId,
        storageKey,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum: createHash('sha256').update(file.buffer).digest('hex'),
        uploadedBy: userId,
      });
    } catch (e) {
      await this.storage.delete(storageKey).catch(() => {}); // không để file mồ côi trên ổ
      throw e;
    }
    return { assetId: id, url: `/${API_PREFIX}/assets/${id}`, mimeType: file.mimetype, sizeBytes: file.size };
  }

  // 404 cả khi không có asset lẫn khi không có quyền xem bảng của nó: người lạ không dò được id ảnh nào tồn tại.
  async open(assetId: string, userId: string) {
    const asset = await this.assets.findById(assetId);
    if (!asset) throw new AppError('ASSET_NOT_FOUND');
    await this.sharing.authorize(asset.boardId, userId, 'view').catch((e: unknown) => {
      throw e instanceof AppError && e.code === 'BOARD_NOT_FOUND' ? new AppError('ASSET_NOT_FOUND') : e;
    });
    return { stream: await this.storage.read(asset.storageKey), mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
  }
}
