import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { requestContext } from '../request-context.js';

// Interceptor chứ không phải middleware: middleware của ta chạy TRƯỚC body parser/multer của Nest, mà các thư viện đó đọc body
// qua sự kiện stream -> callback chạy ngoài ngữ cảnh AsyncLocalStorage, mất store. Interceptor chạy sau, ngay quanh handler.
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const { ip } = context.switchToHttp().getRequest<Request>(); // đã tính trust proxy (TRUST_PROXY)
    // subscribe BÊN TRONG run: handler chỉ chạy khi có người subscribe -> cả chuỗi await của nó thấy store
    return new Observable((subscriber) => requestContext.run({ ip }, () => next.handle().subscribe(subscriber)));
  }
}
