# Hướng dẫn tự code API auth — từng bước

Viết cho: bạn (người tự code SyncBoard). Đọc từ trên xuống, làm xong phần nào chạy test phần đó rồi mới sang phần sau.

Bám theo codebase hiện tại:
- Module chia tầng: `controllers/` → `services/` → `repositories/` (repository **chỉ** chứa query Prisma).
- Validate bằng Zod: `@Body({ schema })`. Lỗi validate trả `{ errors: [{ code: 'VALIDATION_ERROR', field, message }] }`.
- Lỗi nghiệp vụ: `throw new AppError('CODE', 'field?')` (`src/common/errors/app-error.ts`, thêm code mới vào `ERRORS`). `AllExceptionsFilter` đổi mọi lỗi thành `{ errors: [{ code, message, field }] }`. Lỗi Prisma (P2002/P2025/P2003) vẫn có lưới an toàn (409/404/400, code chung), nhưng chỗ nào cần code riêng thì tự bắt rồi ném `AppError`, ví dụ `register` đổi P2002 thành `EMAIL_TAKEN`.
- Guard JWT global (Passport `jwt`). Route mở thì gắn `@Public()`. User hiện tại: `@CurrentUser()`.
- Prefix `/api/v1` tự thêm: `@Controller('auth')` → `/api/v1/auth/...`. Prefix nằm ở **một chỗ**: `API_PREFIX` trong `src/config/api-prefix.ts`. Code nào cần đường dẫn đầy đủ (path cookie, URL callback) phải đọc hằng số này, không gõ cứng `/api/v1`.

Đã kiểm trên máy (2026-10-27): `import { hash, verify } from 'argon2'` chạy được (argon2id, m=64 MiB, t=3, p=4); Prisma 7 có `Prisma.TransactionClient` và `omit`.

---

## 0. Danh sách API

| # | Method + Path | Đăng nhập? | Mục đích | Ưu tiên |
|---|---|---|---|---|
| 1 | `POST /api/v1/auth/register` | Không | Tạo tài khoản | ★ MVP |
| 2 | `POST /api/v1/auth/login` | Không | Đăng nhập bằng mật khẩu | ★ |
| 3 | `POST /api/v1/auth/refresh` | Cookie refresh | Đổi refresh token lấy access token mới (xoay vòng) | ★ |
| 4 | `POST /api/v1/auth/logout` | Cookie refresh | Đăng xuất thiết bị này | ★ |
| 5 | `GET /api/v1/me` | Access token | Thông tin tài khoản (đọc từ DB) | ★ |
| 6 | `POST /api/v1/auth/verify-email` | Không | Xác minh email bằng token trong link | ★ |
| 7 | `POST /api/v1/auth/forgot-password` | Không | Gửi link đặt lại mật khẩu | ★ |
| 8 | `POST /api/v1/auth/reset-password` | Không | Đặt mật khẩu mới bằng token | ★ |
| 9 | `GET /api/v1/auth/google/callback` | Không | Hoàn tất đăng nhập Google (đã có khung) | ★ |
| 10 | `POST /api/v1/auth/logout-all` | Access token | Đăng xuất mọi thiết bị | |
| 11 | `POST /api/v1/auth/resend-verification` | Access token | Gửi lại email xác minh | |
| 12 | `POST /api/v1/auth/change-password` | Access token | Đổi mật khẩu khi đang đăng nhập | |
| 13 | `PATCH /api/v1/me` | Access token | Sửa tên, avatar, tùy chọn | |
| 14 | `GET /api/v1/me/sessions` · `DELETE /api/v1/me/sessions/:id` | Access token | Xem / đăng xuất từng thiết bị | |
| 15 | `DELETE /api/v1/me` | Access token | Xóa tài khoản | |

Thứ tự làm: **Phần A (nền móng)** → API 1 → 2 → 3 → 4 → 5 → 6 → 7–8 → 9 → phần còn lại.

---

## Phần A — Nền móng (làm trước, không có API nào)

API nào cũng cần mấy thứ này. Làm một lần, dùng mãi.

### A1. Sửa `MailModule` (đang thiếu export)

`src/infra/mail/mail.module.ts`: thêm `exports: [MailService]`.

**Vì sao:** `@Global()` chỉ bỏ được bước import module. Provider muốn inject ở module khác vẫn phải nằm trong `exports`. Thiếu dòng này, AuthService báo `Nest can't resolve dependencies ... MailService`.

### A2. `auth/utils/token.util.ts` + test

```ts
import { createHash, randomBytes } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url'); // 43 ký tự, 256 bit
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
```

**Vì sao:**
- `randomBytes` (CSPRNG) chứ không `Math.random()`: token đăng nhập phải không đoán được.
- 32 byte = 256 bit: không thể dò hết.
- `base64url`: an toàn để đặt trong URL và cookie (không có `+`, `/`, `=`).
- `sha256` để **lưu bản băm** vào DB (`token_hash`). Lộ DB cũng không dùng được token. Không cần argon2 cho token vì token đã ngẫu nhiên 256 bit — argon2 chậm có chủ đích là để bù cho mật khẩu do con người đặt (dễ đoán).

Test (`token.util.spec.ts`): hai lần `randomToken()` khác nhau và dài 43; `sha256('a')` luôn ra cùng một chuỗi dài 64.

### A3. `auth/utils/refresh-cookie.ts`

```ts
import type { CookieOptions } from 'express';

export const REFRESH_COOKIE = 'rt';

export function refreshCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,                                   // JavaScript không đọc được -> XSS không lấy được token
    secure: process.env['NODE_ENV'] === 'production', // chỉ gửi qua HTTPS khi lên production
    sameSite: 'lax',                                  // trang lạ không tự gửi cookie trong request POST -> chống CSRF
    path: `/${API_PREFIX}/auth`,                      // cookie CHỈ đi kèm request tới /api/v1/auth/*
    maxAge: maxAgeMs,
  };
}
```

(File này đã có sẵn trong repo, dùng `API_PREFIX` từ `src/config/api-prefix.ts`.)

**Vì sao `path` = `/api/v1/auth`:** refresh token chỉ cần ở endpoint refresh/logout. Giới hạn đường dẫn = mọi request khác (vẽ, lấy bảng...) không mang theo nó → ít chỗ bị lộ hơn.

**Bẫy:** `res.clearCookie` phải truyền **cùng `path`**, nếu không trình duyệt coi là cookie khác và không xóa.

### A4. Kiểu dùng chung

Thêm vào `auth/types/auth.types.ts`:

```ts
export type RequestMeta = { ip?: string; userAgent?: string }; // lưu vào sessions cho trang "thiết bị đang đăng nhập"
export type TokenPair = { accessToken: string; refreshToken: string };
```

### A5. Repository: chỉ query, nhận `tx` tùy chọn

Mẫu dùng cho **mọi** repository:

```ts
import type { Prisma } from '../../../generated/prisma/client.js';

type Db = Prisma.TransactionClient; // PrismaService cũng khớp kiểu này

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string, db: Db = this.prisma) {
    return db.user.findUnique({ where: { email } });
  }
  // ...
}
```

**Vì sao có tham số `db`:** vài thao tác phải ghi nhiều bảng "cùng sống cùng chết" (ví dụ đặt lại mật khẩu: đánh dấu token + đổi mật khẩu + thu hồi phiên). Service mở `this.prisma.$transaction(async (tx) => ...)` rồi truyền `tx` xuống từng repository. Không truyền thì repository dùng `this.prisma` bình thường.

Danh sách method cần viết (viết dần theo từng API, không cần viết hết một lúc):

| Repository | Method |
|---|---|
| `UserRepository` | `findByEmail` (trả cả `passwordHash`, chỉ dùng nội bộ khi login), `findById` (có `omit: { passwordHash: true }`), `findByIdWithPassword` (change-password, xóa tài khoản), `create`, `update`, `softDelete` |
| `SessionRepository` | `create`, `findByTokenHash`, `revoke(id)`, `revokeByTokenHash(hash)`, `revokeFamily(familyId)`, `revokeAllOfUser(userId, exceptId?)`, `listActive(userId)` |
| `OAuthAccountRepository` (API 9) | `findByProvider(provider, providerAccountId)`, `create` |
| `VerificationTokenRepository` | `create`, `findByTokenHash`, `markUsed(id)` |

**Quy tắc:** repository không ném `HttpException`, không quyết định nghiệp vụ. Không tìm thấy → trả `null`, để service quyết định 401 hay 404.

### A6. `UserService` (module user)

```ts
@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}

  normalizeEmail(email: string) { return email.trim().toLowerCase(); }
  findByEmail(email: string) { return this.users.findByEmail(this.normalizeEmail(email)); }
  // findById, create(...) — create cũng chuẩn hóa email
}
```

**Vì sao chuẩn hóa email ở một chỗ:** `An@Mail.com` và `an@mail.com` là cùng một người. Quên chuẩn hóa ở một nơi → tạo được 2 tài khoản cùng email, hoặc đăng nhập "không tìm thấy".

---

## API 1 — `POST /api/v1/auth/register`

**Mục đích:** tạo tài khoản, gửi email xác minh, đăng nhập luôn.

**File:** `dto/register.dto.ts`, `AuthService.register`, `AuthService.issueTokens`, `SessionService.create`, `VerificationService.issue`, `AuthController.register`.

### DTO

```ts
export const registerSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)), // chuẩn hóa TRƯỚC rồi mới kiểm định dạng
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(50),
});
export type RegisterDto = z.infer<typeof registerSchema>;
```

**Bẫy (e2e đã bắt được):** viết `z.email()` thẳng thì `" An@Mail.com "` (người dùng dán kèm dấu cách) bị 400, vì định dạng được kiểm trước khi cắt khoảng trắng. `.pipe()` làm theo thứ tự: trim → chữ thường → kiểm email.

**Vì sao:** `strictObject` từ chối field lạ (ví dụ kẻ xấu gửi thêm `role: 'admin'`). `max(128)` cho mật khẩu: argon2 với chuỗi cực dài vẫn tốn CPU → chặn DoS. Email tối đa 254 ký tự theo chuẩn.

### `SessionService.create(userId, meta, familyId?)` → trả refresh token gốc

Các bước:
1. `token = randomToken()`.
2. `sessions.create({ userId, familyId: familyId ?? randomUUID(), tokenHash: sha256(token), expiresAt: now + REFRESH_TTL_DAYS, userAgent, ip })`.
3. `return token` (bản gốc, chỉ tồn tại lúc này để gửi cho client).

**Vì sao `familyId` mới khi đăng nhập:** mỗi lần đăng nhập trên một thiết bị là một "chuỗi" refresh token. Bị trộm thì thu hồi đúng chuỗi đó, không ảnh hưởng thiết bị khác.

### `AuthService.issueTokens(userId, meta)` → `TokenPair`

```ts
const accessToken = await this.jwt.signAsync({ sub: userId });   // hạn lấy từ JwtModule (JWT_ACCESS_TTL_SECONDS)
const refreshToken = await this.sessions.create(userId, meta);
return { accessToken, refreshToken };
```

**Vì sao tách hàm này:** register, login, Google callback đều kết thúc giống nhau → một chỗ duy nhất phát token.

### `VerificationService.issue(userId, type, ttlMs)` → token gốc

`token = randomToken()` → `create({ userId, type, tokenHash: sha256(token), expiresAt })` → `return token`.

### `AuthService.register(dto, meta)`

1. `passwordHash = await hash(dto.password)` (argon2).
2. `user = await users.create({ email, passwordHash, displayName })`. Email trùng → Prisma ném P2002 → `.catch` bên ngoài `$transaction` đổi thành `throw new AppError('EMAIL_TAKEN', 'email')` → 409 `{ errors: [{ code: 'EMAIL_TAKEN', field: 'email', ... }] }`. Bắt P2002 thay vì `findByEmail` trước, vì hai request đến cùng lúc đều thấy "chưa có"; chỉ unique constraint mới chặn được.
3. `token = await verification.issue(user.id, 'EMAIL_VERIFY', 24h)`.
4. Sau khi transaction commit: `events.emit(USER_REGISTERED, { userId, email, displayName, verifyToken })`.
   - `VerificationMailListener` (`auth/listeners/`, `@OnEvent(USER_REGISTERED, { async: true })`) dựng link `${APP_URL}/verify-email?token=...` rồi gọi `mail.send`.
   - AuthService không biết gì về mail. Muốn thêm việc khi có user mới (audit, thông báo) thì thêm listener, không sửa `register`.
   - Phát **sau** commit, không phát trong transaction: nếu rollback thì mail đã lỡ gửi.
   - Lỗi mail chỉ ghi log. Event chỉ nằm trong RAM: process chết đúng lúc thì mất mail, người dùng dùng `resend-verification`.
5. `return { ...await issueTokens(user.id, meta), user }` — `user` không được có `passwordHash`.

**Vì sao đăng nhập luôn sau khi đăng ký:** trải nghiệm tốt hơn; tính năng nào cần email đã xác minh thì kiểm `emailVerifiedAt` riêng.

**Vì sao link trỏ về frontend (`APP_URL`) chứ không trỏ thẳng API:** trình quét link của dịch vụ email tự "bấm" các link `GET` → nếu link gọi thẳng API xác minh thì token bị dùng mất trước khi người dùng mở. Frontend mở trang, rồi frontend gọi `POST /verify-email`.

### Controller

```ts
@Public()
@Post('register')
async register(
  @Body({ schema: registerSchema }) dto: RegisterDto,
  @Req() req: Request,
  @Res({ passthrough: true }) res: Response,
) {
  const { accessToken, refreshToken, user } = await this.auth.register(dto, metaOf(req));
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(this.refreshMaxAgeMs));
  return { accessToken, user };
}
```

`metaOf(req)` = `{ ip: req.ip, userAgent: req.get('user-agent') }` (viết một hàm nhỏ trong controller).

**Vì sao `passthrough: true`:** khi inject `@Res()`, Nest mặc định giao toàn bộ việc trả response cho bạn → `return` bị bỏ qua và request treo. `passthrough` = "tôi chỉ đặt cookie, phần trả JSON vẫn để Nest lo".

**Vì sao access token trong body, refresh token trong cookie:** access token frontend cần đọc để gắn header `Authorization` (giữ trong bộ nhớ JS, mất khi F5 thì refresh lại). Refresh token sống lâu, nguy hiểm hơn → cookie `httpOnly` JavaScript không đọc được.

**Test (e2e):** 201 + có `accessToken`; header `Set-Cookie` chứa `rt=`, `HttpOnly`, `Path=/api/v1/auth`; body không có `passwordHash`; đăng ký lại cùng email → 409 `EMAIL_TAKEN`; email sai định dạng → 400 `VALIDATION_ERROR` với `field: 'email'`.

---

## API 2 — `POST /api/v1/auth/login`

**Mục đích:** đổi email + mật khẩu lấy cặp token.

### `AuthService.login(dto, meta)`

1. `user = await users.findByEmail(dto.email)` (bản có `passwordHash`).
2. Nếu `!user || user.deletedAt || !user.passwordHash` → vẫn chạy `verify(DUMMY_HASH, dto.password)` rồi `throw new UnauthorizedException('Invalid email or password')`.
3. `if (!(await verify(user.passwordHash, dto.password)))` → cùng lỗi trên.
4. `return { ...await issueTokens(user.id, meta), user: withoutPassword(user) }`.

`DUMMY_HASH` = một hash argon2 tạo sẵn một lần (hằng số trong file).

**Vì sao cùng một thông báo lỗi:** "Email không tồn tại" vs "Sai mật khẩu" cho kẻ xấu biết email nào có tài khoản (dò danh sách user).

**Vì sao vẫn chạy `verify` khi không có user:** argon2 mất ~50–100 ms. Không có user mà trả lỗi ngay thì nhanh hơn hẳn → đo thời gian phản hồi là biết email có tồn tại. Chạy verify giả làm hai nhánh mất thời gian như nhau.

**Vì sao `@HttpCode(200)`:** POST mặc định trả 201 (Created). Đăng nhập không tạo tài nguyên → 200.

**Test:** đúng → 200 + cookie; sai mật khẩu và email không tồn tại → **cùng** body 401; tài khoản Google-only (không có mật khẩu) → 401.

---

## API 3 — `POST /api/v1/auth/refresh` (khó nhất)

**Mục đích:** access token hết hạn sau 15 phút; frontend gọi endpoint này (cookie tự gửi kèm) để lấy cặp token mới mà không bắt đăng nhập lại.

`@Public()` — vì lúc gọi, access token **đã hết hạn**.

### `SessionService.rotate(oldToken, meta)` → `{ userId, refreshToken }`

1. `old = await sessions.findByTokenHash(sha256(oldToken))`. Không có hoặc `expiresAt < now` → `UnauthorizedException`.
2. **`old.revokedAt` có giá trị** (token đã chết bị dùng lại):
   - Nếu `old.replacedById` có và `now - old.revokedAt < 10 giây` → hai tab cùng refresh: chỉ `throw new UnauthorizedException()`, **không thu hồi gì** (tab chậm sẽ thử lại với cookie mới).
   - Ngược lại → **bị trộm**: `sessions.revokeFamily(old.familyId)` rồi `throw new UnauthorizedException()`.
3. Hợp lệ → trong `this.prisma.$transaction(async (tx) => { ... })`:
   - tạo session mới: cùng `userId`, **cùng `familyId`**, token mới;
   - cập nhật session cũ: `revokedAt = now`, `replacedById = <id mới>`.
4. Trả `{ userId: old.userId, refreshToken: <token mới> }`.

**Vì sao xoay vòng:** mỗi refresh token dùng được **một lần**. Kẻ trộm và người thật không thể cùng dùng một chuỗi mà không lộ — ai dùng lại token cũ là bị phát hiện (RFC 9700 §4.14.2, xem implementation-guide mục 6.3).

**Vì sao transaction:** nếu tạo session mới xong mà sập trước khi revoke cái cũ → hai token cùng sống. Transaction đảm bảo cả hai cùng xong hoặc cùng không.

**Vì sao khoảng ân hạn 10 giây:** mở hai tab, cả hai thấy access token hết hạn và refresh gần như cùng lúc. Không có ân hạn → tab chậm bị coi là kẻ trộm → người dùng bị đăng xuất vô lý. (10 giây là con số tự chọn, không phải chuẩn.)

### Controller

1. `token = req.cookies[REFRESH_COOKIE]`; không có → 401.
2. `{ userId, refreshToken } = await sessions.rotate(token, meta)`.
3. `accessToken = await jwt.signAsync({ sub: userId })`.
4. Đặt cookie mới, trả `{ accessToken }`.

**Test (unit `session.service.spec.ts`, mock repository):** hợp lệ; hết hạn; dùng lại trong 10 giây (không revokeFamily); dùng lại sau 10 giây (gọi revokeFamily). **E2e:** refresh hai lần bằng **cùng** cookie cũ → lần hai 401.

---

## API 4 — `POST /api/v1/auth/logout`

`@Public()` (access token có thể đã hết hạn — vẫn phải đăng xuất được).

1. `token = req.cookies[REFRESH_COOKIE]`; có thì `SessionService.revoke(token)` → repository `revokeByTokenHash(sha256(token))`.
2. `res.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions(0).path })` — lấy path từ cùng một hàm với lúc đặt cookie, không gõ cứng.
3. `@HttpCode(204)`, không trả body.

**Vì sao không báo lỗi khi không có cookie:** đăng xuất là thao tác "đảm bảo trạng thái cuối" (idempotent): gọi bao nhiêu lần cũng kết thúc ở trạng thái đã đăng xuất.

**Test:** logout → refresh bằng cookie đó → 401.

---

## API 5 — `GET /api/v1/me` (nâng cấp)

Hiện đang trả `{ id }` từ token. Đổi thành đọc DB:

```ts
@Get()
me(@CurrentUser() user: AuthUser) {
  return this.users.findById(user.id); // repository dùng omit: { passwordHash: true }
}
```

Không tìm thấy (tài khoản vừa bị xóa) → `NotFoundException` — throw ở **service**, không ở repository.

**Vì sao không nhét tên/email vào JWT để khỏi tra DB:** payload là ảnh chụp lúc ký. Đổi tên → token cũ vẫn mang tên cũ tới 15 phút. Chỉ để `sub` trong token, còn lại đọc DB.

**Vì sao `omit` ở repository:** một chỗ duy nhất đảm bảo `passwordHash` không bao giờ ra khỏi tầng dữ liệu. Tránh kiểu "nhớ xóa field trước khi return" ở từng controller.

---

## API 6 — `POST /api/v1/auth/verify-email`

`@Public()`, body `{ token }`, `@HttpCode(204)`.

### `VerificationService.consume(token, type, db)` → `userId`

1. `row = findByTokenHash(sha256(token), db)`.
2. Không có / sai `type` / `usedAt` có giá trị / `expiresAt < now` → `BadRequestException('Invalid or expired token')`.
3. `markUsed(row.id, db)`; `return row.userId`.

### `AuthService.verifyEmail(token)`

```ts
await this.prisma.$transaction(async (tx) => {
  const userId = await this.verification.consume(token, 'EMAIL_VERIFY', tx);
  await this.users.update(userId, { emailVerifiedAt: new Date() }, tx);
});
```

**Vì sao POST chứ không GET:** xem lý do ở API 1 (trình quét email tự bấm link GET).

**Vì sao một thông báo cho mọi lỗi token:** không cho kẻ xấu phân biệt "token đúng nhưng hết hạn" với "token không tồn tại".

---

## API 7 — `POST /api/v1/auth/forgot-password`

`@Public()`, body `{ email }`, **luôn** `@HttpCode(204)`.

1. `user = users.findByEmail(email)`.
2. Có user (và chưa xóa) → `token = verification.issue(user.id, 'PASSWORD_RESET', 30 phút)` → gửi mail `${APP_URL}/reset-password?token=...`.
3. Không có user → **không làm gì**, vẫn trả 204.

**Vì sao luôn 204:** trả 404 cho email không tồn tại = cho kẻ xấu công cụ dò email.

**Vì sao hạn ngắn (30 phút) so với xác minh email (24h):** link đặt lại mật khẩu = quyền chiếm tài khoản. Càng sống ngắn càng ít rủi ro nếu hộp mail bị lộ.

---

## API 8 — `POST /api/v1/auth/reset-password`

`@Public()`, body `{ token, newPassword }`, `@HttpCode(204)`.

```ts
await this.prisma.$transaction(async (tx) => {
  const userId = await this.verification.consume(token, 'PASSWORD_RESET', tx);
  await this.users.update(userId, { passwordHash: await hash(newPassword) }, tx);
  await this.sessions.revokeAllOfUser(userId, undefined, tx);
});
```

**Vì sao thu hồi mọi phiên:** người dùng đặt lại mật khẩu thường vì nghi bị lộ. Kẻ đang đăng nhập bằng mật khẩu cũ phải bị đẩy ra ngay. Đây là bước hay bị quên nhất.

**Vì sao trong một transaction:** đổi mật khẩu xong mà chưa thu hồi phiên (do lỗi giữa chừng) = lỗ hổng. Token bị đánh dấu dùng mà mật khẩu chưa đổi = người dùng phải xin link lại.

**Hash argon2 trước khi mở transaction** nếu muốn transaction ngắn hơn (argon2 ~100 ms giữ kết nối DB vô ích). Tức là: `const passwordHash = await hash(newPassword)` ở ngoài, rồi mới `$transaction`.

**Test e2e:** forgot → lấy token (spy `MailService.send`) → reset → login mật khẩu cũ 401, mới 200 → refresh bằng cookie trước khi reset → 401.

---

## API 9 — `GET /api/v1/auth/google/callback` (hoàn tất)

Khung đã có (Passport lo phần Google). Bạn viết `AuthService.oauthLogin(profile, meta)`:

1. `account = oauthAccounts.findByProvider(profile.provider, profile.providerAccountId)` → có thì `userId = account.userId`.
2. Không có:
   - `existing = users.findByEmail(profile.email)`;
   - `existing && profile.emailVerified` → tạo `oauth_accounts` trỏ vào `existing.id` (liên kết);
   - `existing && !profile.emailVerified` → **không liên kết**, báo lỗi (409 "Email đã có tài khoản, hãy đăng nhập bằng mật khẩu rồi liên kết");
   - không có `existing` → tạo user mới (`passwordHash: null`, `emailVerifiedAt: now`) + `oauth_accounts` — trong một transaction.
3. `return issueTokens(userId, meta)`.

Controller: đặt cookie refresh → `res.redirect(\`${APP_URL}/auth/callback\`)`. **Không** đặt access token lên URL — frontend gọi `/api/v1/auth/refresh` (cookie vừa đặt) để lấy.

**Vì sao tìm theo `providerAccountId` (sub) trước, email sau:** người dùng đổi email bên Google thì `sub` vẫn vậy.

**Vì sao bắt `emailVerified`:** không kiểm → kẻ xấu tạo tài khoản Google với email của bạn (chưa xác minh) → đăng nhập vào tài khoản của bạn.

**Vì sao không đưa token lên URL:** URL bị lưu trong lịch sử trình duyệt, log server, header `Referer`.

Cần thêm: `OAuthAccountRepository` (`findByProvider`, `create`) trong `auth/repositories/`.

---

## API 10–15 — làm sau MVP

| API | Các bước chính | Vì sao |
|---|---|---|
| `POST /auth/logout-all` | `revokeAllOfUser(user.id)` + `clearCookie` | Nghi bị lộ, đăng xuất mọi nơi một nút bấm |
| `POST /auth/resend-verification` | Đã xác minh → 204 luôn; chưa → `issue` + gửi mail. **Rate limit** | Chặn spam email |
| `POST /auth/change-password` | Kiểm `currentPassword` (argon2) → hash mới → `revokeAllOfUser(userId, exceptCurrentSessionId)` | Kẻ có access token (chưa có mật khẩu) không đổi được mật khẩu; thiết bị hiện tại không bị đá |
| `PATCH /me` | Schema chỉ cho `displayName`, `avatarUrl`, `preferences` | `strictObject` chặn sửa `email`/`passwordHash` qua đường này |
| `GET /me/sessions` | `listActive(userId)`: chưa revoke, chưa hết hạn; đánh dấu phiên hiện tại | Trang "thiết bị đang đăng nhập" |
| `DELETE /me/sessions/:id` | Revoke **chỉ khi** session thuộc user hiện tại | Không kiểm chủ sở hữu = đăng xuất được người khác (lỗi IDOR) |
| `DELETE /me` | Body `{ password }` xác nhận → `softDelete` + `revokeAllOfUser` | Xác thực lại trước hành động không thể hoàn tác |

---

## Phần B — Sau API: xác thực socket

`BoardGateway.afterInit(server)` thêm middleware (implementation-guide mục 6.2):

```ts
server.use(async (socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(); // khách vào bằng link chia sẻ
  try {
    socket.data.userId = (await this.jwt.verifyAsync<JwtPayload>(token)).sub;
    next();
  } catch {
    next(new Error('unauthorized')); // client nhận connect_error
  }
});
```

**Vì sao không dùng Passport ở đây:** Passport làm việc với request HTTP. Socket chỉ cần đúng một lần verify lúc bắt tay.

---

## Phần C — Rate limit (trước khi đưa lên mạng)

`@nestjs/throttler` cho `register`, `login`, `forgot-password`, `reset-password`, `resend-verification` (ví dụ 5 lần/phút/IP). Chạy nhiều server → bộ đếm phải nằm trong Redis. Kiểm tài liệu `@nestjs/throttler` khi tới bước này.

**Vì sao:** không giới hạn = bot thử mật khẩu không ngừng và spam email đặt lại mật khẩu cho người khác.

---

## Bẫy hay gặp

| Triệu chứng | Nguyên nhân |
|---|---|
| Request treo, không bao giờ trả về | `@Res()` thiếu `{ passthrough: true }` |
| Đăng xuất xong vẫn refresh được | `clearCookie` khác `path` lúc đặt cookie |
| Response chứa `passwordHash` | Quên `omit` ở repository |
| Login trả 201 | Thiếu `@HttpCode(200)` |
| `req.cookies` là `undefined` | `cookieParser()` chưa chạy (đã có trong `setupApp`, kiểm lại nếu viết test dựng app riêng) |
| `req.ip` luôn là IP của proxy khi deploy | Cần bật `trust proxy` của Express khi chạy sau load balancer |
| Login chậm bất thường khi test nhiều | argon2 cố ý chậm (~100 ms/lần). Bình thường |

## Mỗi API xong thì

```bash
npx tsc --noEmit && npm run lint && npm test && npm run test:e2e
git add -A && git commit -m "feat(auth): <API vừa xong>"
```
