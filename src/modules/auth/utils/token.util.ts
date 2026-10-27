import { createHash, randomBytes } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url'); // 43 ký tự, 256 bit
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
