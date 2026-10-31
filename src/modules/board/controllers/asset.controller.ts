import {
  Controller,
  FileTypeValidator,
  Get,
  Param,
  ParseFilePipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { minutes, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthUser } from '../../auth/types/auth.types.js';
import { AssetService, type UploadedImage } from '../services/asset.service.js';

const uuid = { schema: z.uuid() };
const MAX_BYTES = 10 * 1024 * 1024;

@Controller()
export class AssetController {
  constructor(private readonly assets: AssetService) {}

  // multipart, field "file". limits.fileSize: multer dừng nhận ngay khi vượt -> 413 (file nằm trong RAM nên bắt buộc có giới hạn).
  // FileTypeValidator của Nest 12 dò magic byte (nội dung file), không tin Content-Type client gửi. SVG không có trong allowlist (XSS).
  @Post('boards/:boardId/assets')
  @Throttle({ default: { limit: 30, ttl: minutes(1) } }) // mỗi request giữ tới 10 MB trong RAM
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  upload(
    @Param('boardId', uuid) boardId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new FileTypeValidator({ fileType: /^image\/(png|jpeg|gif|webp)$/, overrideMimeType: true })],
        exceptionFactory: () => new AppError('INVALID_IMAGE', 'file'),
      }),
    )
    file: UploadedImage,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assets.upload(boardId, user.id, file);
  }

  // Cần Authorization header -> thẻ <img src> không tự gửi được: FE fetch() kèm token rồi dùng URL.createObjectURL(blob).
  @Get('assets/:assetId')
  async serve(@Param('assetId', uuid) assetId: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const asset = await this.assets.open(assetId, user.id);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // id mới cho mỗi file -> nội dung không bao giờ đổi
    return new StreamableFile(asset.stream, { type: asset.mimeType, length: asset.sizeBytes });
  }
}
