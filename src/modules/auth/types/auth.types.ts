export type AuthUser = { id: string };   // thứ guard gắn vào request.user
export type JwtPayload = { sub: string }; // nội dung bên trong access token

// Dữ liệu chung mọi strategy OAuth trả về (Google, sau này GitHub...). provider khớp enum OAuthProvider trong Prisma.
export type OAuthProfile = {
  provider: 'GOOGLE';
  providerAccountId: string;
  email?: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl?: string;
};

export type RequestMeta = { ip?: string; userAgent?: string }; // lưu vào sessions cho trang "thiết bị đang đăng nhập"
export type TokenPair = { accessToken: string; refreshToken: string };
