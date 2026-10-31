import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation.js';
import { LocalDiskStorage } from './local-disk.storage.js';
import { STORAGE } from './storage.interface.js';

@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => new LocalDiskStorage(config.get('UPLOAD_DIR', { infer: true })),
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
