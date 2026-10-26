import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

// Middleware chứ không phải interceptor: interceptor bỏ sót request 404 và request bị guard chặn.
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  if (req.originalUrl === '/health') return next(); // load balancer gọi liên tục, log ra chỉ thành rác
  const start = performance.now();
  res.on('finish', () => {
    const ms = (performance.now() - start).toFixed(1);
    logger.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
}
