import { AsyncLocalStorage } from 'node:async_hooks';

// Dữ liệu của request đang chạy, đọc được ở bất kỳ đâu trong chuỗi await của nó (không phải truyền tham số qua mọi hàm).
// Gán ở RequestContextInterceptor. Ngoài request HTTP (socket, job nền) thì trống.
type RequestContext = { ip?: string };

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentIp = () => requestContext.getStore()?.ip;
