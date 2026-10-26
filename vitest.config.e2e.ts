import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '', // thắng .env: e2e không đụng DB dev
      // Client Google giả: đủ để test bước chuyển hướng và kiểm state, không gọi tới Google thật
      GOOGLE_CLIENT_ID: 'e2e-client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'e2e-secret',
    },
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
