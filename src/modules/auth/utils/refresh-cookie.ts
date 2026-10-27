
import type { CookieOptions } from 'express';
import { API_PREFIX } from '../../../config/api-prefix.js';

export const REFRESH_COOKIE = 'rt';

export function refreshCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,                                   // JavaScript không đọc được -> XSS không lấy được token
    secure: process.env['NODE_ENV'] === 'production', // chỉ gửi qua HTTPS khi lên production
    sameSite: 'lax',                                  // trang lạ không tự gửi cookie trong request POST -> chống CSRF
    path: `/${API_PREFIX}/auth`,                      // cookie CHỈ đi kèm request tới /api/v1/auth/*; clearCookie phải dùng đúng path này
    maxAge: maxAgeMs,
  };
}
