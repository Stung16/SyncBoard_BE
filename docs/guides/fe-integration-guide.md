# SyncBoard — Tài liệu tích hợp cho Frontend

Viết cho: người làm frontend, chưa đọc code backend. Đọc xong phải ghép được đủ tính năng mà không cần mở code BE.

Đối chiếu với code BE ngày 2026-10-31 (nhánh `develop`, commit `cd3d849`). Có chỗ nào tài liệu và BE chạy khác nhau thì **BE đúng**, báo lại để sửa tài liệu.

Mục lục:

1. [Quy ước chung](#1-quy-ước-chung)
2. [Đăng nhập và phiên](#2-đăng-nhập-và-phiên)
3. [REST API: danh sách đầy đủ](#3-rest-api-danh-sách-đầy-đủ)
4. [Socket.IO: kết nối và vòng đời](#4-socketio-kết-nối-và-vòng-đời)
5. [Socket.IO: danh sách sự kiện](#5-socketio-danh-sách-sự-kiện)
6. [Element và op: mô hình dữ liệu của bảng](#6-element-và-op-mô-hình-dữ-liệu-của-bảng)
7. [Use case: FE phải xử lý thế nào](#7-use-case-fe-phải-xử-lý-thế-nào)
8. [Phân quyền: ẩn/hiện gì theo vai trò](#8-phân-quyền-ẩnhiện-gì-theo-vai-trò)
9. [Giới hạn](#9-giới-hạn)
10. [Mã lỗi](#10-mã-lỗi)
11. [BE chưa có / hạn chế đã biết](#11-be-chưa-có--hạn-chế-đã-biết)
12. [Thứ tự làm FE đề xuất](#12-thứ-tự-làm-fe-đề-xuất)

---

## 1. Quy ước chung

| Mục | Giá trị |
|---|---|
| Base URL REST | `http://localhost:3000/api/v1` (prefix `api/v1` cố định cho mọi route, trừ `/health`) |
| Socket.IO | `http://localhost:3000`, path mặc định `/socket.io` (**không** có `/api/v1`) |
| Origin FE khi dev | `http://localhost:5173` (BE cho phép qua `CORS_ORIGIN`, có `credentials: true`) |
| Swagger | `http://localhost:3000/api/v1/docs` (chỉ khi không phải production). Validate bằng Zod nên Swagger chỉ liệt kê route, **không có schema body**: xem body ở tài liệu này |
| Định dạng | JSON. Ngày giờ là chuỗi ISO 8601 (`"2026-10-31T08:00:00.000Z"`) |
| Id do server sinh | UUID v7 (user, board, comment, asset, snapshot, notification...) |
| Id do client sinh | `element.id`: chuỗi 1–64 ký tự, dùng `crypto.randomUUID()`. `opId`, `clientId`: **bắt buộc UUID** |
| Xác thực REST | Header `Authorization: Bearer <accessToken>` cho mọi route, trừ các route ghi "Không" ở cột đăng nhập |
| Cookie | Refresh token nằm trong cookie httpOnly tên `rt`, `path=/api/v1/auth`, `SameSite=Lax`. JS không đọc được; chỉ cần gửi `credentials: 'include'` khi gọi `/auth/*` |

### 1.1 Định dạng lỗi (mọi lỗi HTTP)

```json
{
  "errors": [
    { "code": "VALIDATION_ERROR", "message": "Too small: expected string to have >=8 characters", "field": "password" },
    { "code": "VALIDATION_ERROR", "message": "Invalid email address", "field": "email" }
  ]
}
```

- **FE xử lý theo `code`, không parse `message`.** `message` của lỗi nghiệp vụ là câu tiếng Việt hiển thị được; `message` của `VALIDATION_ERROR` là tiếng Anh của Zod (nên tự dịch theo `field`).
- `field`: tên ô nhập bị lỗi để hiện ngay dưới ô (`"email"`, `"ops.0.element.data.x"`...), `null` nếu không gắn với ô nào.
- `details`: chỉ có ở vài lỗi, ví dụ `RATE_LIMITED` có `details.retryAfterSeconds`.
- Bảng mã lỗi đầy đủ: [mục 10](#10-mã-lỗi).

### 1.2 Giới hạn tần suất HTTP

- Mặc định 120 request/phút. Đã đăng nhập thì đếm theo user, chưa thì theo IP.
- Một số route chặt hơn (ghi ở cột "Giới hạn" trong [mục 3](#3-rest-api-danh-sách-đầy-đủ)).
- Vượt: `429` với `code: "RATE_LIMITED"`, `details.retryAfterSeconds`, kèm header `Retry-After`. FE hiện "thử lại sau N giây", **không tự retry liên tục**.

### 1.3 Gợi ý: dùng lại schema Zod của BE

Toàn bộ validate dùng Zod 4. Nên chép các file sau sang FE (chúng không phụ thuộc NestJS) để có type và tự kiểm trước khi gửi:

- `src/modules/board/dto/element.dto.ts`: schema `data` của từng loại element
- `src/modules/board/dto/op.dto.ts`: schema op và lô `SubmitOps`
- `src/modules/realtime/dto/*.ts`: payload các sự kiện socket

Lý do quan trọng: lô `SubmitOps` sai định dạng bị từ chối **cả lô và không có ack** (xem [4.5](#45-lỗi-trên-socket)). Kiểm ở FE trước thì tránh được loại lỗi khó gỡ này.

---

## 2. Đăng nhập và phiên

### 2.1 Mô hình token

| Token | Ở đâu | Sống bao lâu | Dùng để |
|---|---|---|---|
| Access token (JWT) | **Bộ nhớ JS** (biến/store). Không lưu localStorage | 15 phút (`JWT_ACCESS_TTL_SECONDS`) | Header `Authorization` cho REST; `auth.token` khi mở socket |
| Refresh token | Cookie httpOnly `rt` (BE tự đặt) | 30 ngày (`REFRESH_TTL_DAYS`; `.env` dev đang để 5) | Gọi `POST /auth/refresh` lấy access token mới |

Refresh token **xoay vòng**: mỗi lần refresh, BE thu hồi token cũ và đặt cookie mới. Token cũ bị dùng lại sau hơn 10 giây thì BE coi là bị đánh cắp và thu hồi **mọi phiên của thiết bị đó** → người dùng phải đăng nhập lại.

### 2.2 Luồng đăng ký → xác minh email → đăng nhập

```
[Form đăng ký] --POST /auth/register--> 201 { user, requiresEmailVerification: true }
      → Màn "Kiểm tra email" (có nút "Gửi lại" → POST /auth/resend-verification)

[Email] link: {APP_URL}/verify-email?token=XXX
      → Trang FE /verify-email đọc token từ query, gọi POST /auth/verify-email { token }
      → 200 { accessToken, user } + cookie rt   ⇒ ĐÃ ĐĂNG NHẬP luôn, chuyển vào app
      → 400 INVALID_VERIFY_TOKEN ⇒ "Link hết hạn" + nút gửi lại
```

- Link xác minh sống 24 giờ, dùng một lần.
- Trang `/verify-email` **không được tự gọi API bằng GET**: BE cố ý dùng POST để trình quét email không dùng mất token. FE gọi POST khi trang mở là được (trình quét không chạy JS).
- Đăng nhập khi chưa xác minh: `403 EMAIL_NOT_VERIFIED` → hiện nút "Gửi lại email xác minh".
- `resend-verification` và `forgot-password` **luôn trả 204** dù email có tồn tại hay không (chống dò email). FE luôn hiện "Nếu email tồn tại, chúng tôi đã gửi link". Mỗi tài khoản tối đa 1 mail/60 giây.

### 2.3 Quên mật khẩu

```
POST /auth/forgot-password { email }  → 204 (luôn luôn)
Email: {APP_URL}/reset-password?token=XXX   (sống 1 giờ)
Trang FE /reset-password: form mật khẩu mới → POST /auth/reset-password { token, password }
  → 204 ⇒ chuyển tới trang đăng nhập (BE KHÔNG tự đăng nhập)
  → 400 INVALID_RESET_TOKEN ⇒ link hỏng/hết hạn
```

Đặt lại mật khẩu thành công thì BE **đăng xuất mọi thiết bị** và tự đánh dấu email đã xác minh.

### 2.4 Khởi động app (F5, mở tab mới)

Access token chỉ ở bộ nhớ nên F5 là mất. Khi app khởi động:

```ts
// 1. Thử lấy access token từ cookie refresh
const r = await fetch(`${API}/auth/refresh`, { method: 'POST', credentials: 'include' });
if (r.ok) {
  accessToken = (await r.json()).accessToken;
  me = await api.get('/me');          // hồ sơ
  connectSocket();                    // xem mục 4
} else {
  // 401 INVALID_REFRESH_TOKEN -> chưa đăng nhập -> trang login
}
```

### 2.5 Interceptor 401 (bắt buộc)

```ts
// Gọi API: 401 với code UNAUTHORIZED = access token hết hạn -> refresh MỘT lần rồi gửi lại
async function request(path, init) {
  let res = await send(path, init);
  if (res.status === 401 && !path.startsWith('/auth/')) {   // ĐỪNG refresh khi login sai mật khẩu (cũng 401)
    if (await refreshOnce()) res = await send(path, init);
    else goToLogin();
  }
  return res;
}
```

**Nhiều request / nhiều tab cùng refresh:** phải gộp lại thành **một** lần refresh.

- Trong một tab: giữ một `Promise` refresh đang chạy, request khác chờ promise đó (single-flight).
- Giữa các tab: dùng `navigator.locks.request('syncboard-refresh', ...)` để các tab refresh lần lượt. Tab sau vào lock thì thử gọi lại API trước. Nếu vẫn 401 mới refresh. Cookie đã là cookie mới nên không bị lỗi.
- Không có lock giữa tab: tab chậm sẽ gửi cookie cũ và nhận `INVALID_REFRESH_TOKEN` (trong 10 giây đầu BE **không** coi là trộm, chỉ từ chối). Gặp lỗi này thì chờ ~300 ms rồi thử refresh lại một lần, trước khi đẩy về trang login.

Nên refresh chủ động trước khi hết hạn (ví dụ ở phút thứ 13) để giảm số 401.

### 2.6 Đăng xuất

`POST /auth/logout` (kèm `credentials: 'include'`) → 204, BE thu hồi phiên và xóa cookie. Sau đó FE: xóa access token, `socket.disconnect()`, xóa cache, về trang login. Gọi được cả khi access token đã hết hạn.

### 2.7 Đăng nhập Google: **chưa dùng được**

Route `GET /auth/google` và `/auth/google/callback` đã có, nhưng callback **chưa phát token** (đang là TODO ở BE). FE ẩn nút Google cho tới khi BE xong. Khi xong, luồng dự kiến là: FE điều hướng cả trang tới `/api/v1/auth/google` → Google → BE đặt cookie → redirect về `{APP_URL}/auth/callback` → FE gọi `POST /auth/refresh` như mục 2.4.

### 2.8 Cookie khi lên production

Cookie `SameSite=Lax`: FE và BE phải **cùng site** (cùng tên miền gốc, ví dụ `app.syncboard.vn` và `api.syncboard.vn`), nếu không trình duyệt không gửi cookie trong `fetch` và refresh luôn thất bại. Production bật thêm `Secure` nên phải chạy HTTPS. Dev `localhost:5173` ↔ `localhost:3000` là cùng site (cổng không tính), chạy được.

---

## 3. REST API: danh sách đầy đủ

Đường dẫn dưới đây **đã bỏ** `/api/v1`. "Đăng nhập": Có = cần `Authorization: Bearer`.

### 3.1 Auth

| Method + Path | Đăng nhập | Body | Thành công | Lỗi hay gặp | Giới hạn |
|---|---|---|---|---|---|
| `POST /auth/register` | Không | `{ email, password, displayName }` | `201 { user, requiresEmailVerification: true }` | `409 EMAIL_TAKEN` (field `email`) | 5/giờ |
| `POST /auth/verify-email` | Không | `{ token }` | `200 { accessToken, user }` + cookie | `400 INVALID_VERIFY_TOKEN` | |
| `POST /auth/resend-verification` | Không | `{ email }` | `204` (luôn) | | 5/giờ |
| `POST /auth/login` | Không | `{ email, password }` | `200 { accessToken, user }` + cookie | `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_VERIFIED` | 5/phút, quá thì khóa 15 phút |
| `POST /auth/forgot-password` | Không | `{ email }` | `204` (luôn) | | 5/giờ |
| `POST /auth/reset-password` | Không | `{ token, password }` | `204` | `400 INVALID_RESET_TOKEN` | 10/giờ |
| `POST /auth/refresh` | Cookie | (không body) | `200 { accessToken }` + cookie mới | `401 INVALID_REFRESH_TOKEN` | 30/phút |
| `POST /auth/logout` | Cookie | (không body) | `204` (luôn) | | |
| `GET /me` | Có | | `200 User` | `404 USER_NOT_FOUND` (tài khoản đã xóa → đăng xuất) | |

Luật validate:

- `email`: BE tự cắt khoảng trắng và đổi chữ thường, phải là email hợp lệ, ≤ 254 ký tự.
- `password`: 8–128 ký tự khi đăng ký/đặt lại; khi đăng nhập chỉ cần 1–128.
- `displayName`: 1–50 ký tự sau khi cắt khoảng trắng.
- Body là **strict**: gửi thừa field → `VALIDATION_ERROR`.

```ts
type User = {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  displayName: string;
  avatarUrl: string | null;
  preferences: Record<string, unknown>;  // hiện luôn {} (chưa có API sửa)
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
```

### 3.2 Bảng (board)

| Method + Path | Ai dùng được | Body / Query | Thành công |
|---|---|---|---|
| `POST /boards` | Mọi user đăng nhập (thành OWNER) | `{ title? }` (1–50 ký tự; bỏ trống → `"Untitled"`) | `201 { id, title, createdAt }` |
| `GET /boards?search=` | Mọi user | `search` ≤ 50 ký tự, không phân biệt hoa thường | `200 BoardListItem[]` (tối đa 100, sửa gần nhất lên đầu) |
| `GET /boards/:boardId` | Thành viên | | `200 { id, title, role }` |
| `PATCH /boards/:boardId` | OWNER | `{ title }` | `200 { id, title, createdAt, updatedAt }` + socket `BoardRenamed` |
| `DELETE /boards/:boardId` | OWNER | | `204` + socket `AccessChanged { reason: 'board_deleted' }` cho mọi người đang mở |
| `GET /boards/:boardId/audit-logs?before=` | OWNER | `before` = `id` dòng cuối của trang trước | `200 AuditLog[]` (100 dòng/trang, mới nhất trước) |

```ts
type Role = 'OWNER' | 'EDITOR' | 'COMMENTER' | 'VIEWER';
type BoardListItem = { id: string; title: string; createdAt: string; updatedAt: string; role: Role };
type AuditLog = {
  id: string; actorId: string | null; ip: string | null; createdAt: string;
  action: 'board.create' | 'board.rename' | 'board.delete' | 'board.clear' | 'member.role_change' | 'member.remove'
        | 'share_link.create' | 'share_link.revoke' | 'invitation.create' | 'invitation.revoke' | 'invitation.accept'
        | 'snapshot.restore' | string;
  metadata: Record<string, unknown> | null;  // ví dụ role_change: { userId, from, to }
};
```

Quy tắc chung cho mọi route `/boards/:boardId/...`:

- Không phải thành viên (hoặc bảng không tồn tại/đã xóa) → `404 BOARD_NOT_FOUND`. BE cố ý không phân biệt hai trường hợp này.
- Là thành viên nhưng vai trò không đủ → `403 BOARD_FORBIDDEN`.
- Id sai định dạng UUID → `400 VALIDATION_ERROR`.

### 3.3 Chia sẻ (chỉ OWNER)

| Method + Path | Body | Thành công | Lỗi |
|---|---|---|---|
| `GET /boards/:boardId/members` | | `200 Member[]` | |
| `PATCH /boards/:boardId/members/:userId` | `{ role }` | `200 { userId, role }`; người đó bị đá khỏi socket với `role_changed` | `404 MEMBER_NOT_FOUND`, `400 OWNER_ROLE_FIXED` |
| `DELETE /boards/:boardId/members/:userId` | | `204`; người đó bị đá với `removed` | như trên |
| `POST /boards/:boardId/share-links` | `{ role, expiresInHours? }` (1 – 8760; bỏ trống = không hết hạn) | `201 ShareLink` | |
| `GET /boards/:boardId/share-links` | | `200 ShareLink[]` (chỉ link còn dùng được) | |
| `DELETE /boards/:boardId/share-links/:linkId` | | `204`; ai đang vào bằng link bị đá với `link_revoked` | `404 SHARE_LINK_NOT_FOUND` |
| `POST /boards/:boardId/invitations` | `{ email, role }` | `201 Invitation` (BE gửi mail) | |
| `GET /boards/:boardId/invitations` | | `200 Invitation[]` (chưa nhận, chưa hết hạn) | |
| `DELETE /boards/:boardId/invitations/:invitationId` | | `204` | `404 INVITATION_NOT_FOUND` |
| `POST /invitations/accept` | `{ token }` | `200 { boardId, role }` | `400 INVALID_INVITATION`, `403 INVITATION_EMAIL_MISMATCH` |

- `role` gửi lên chỉ được `EDITOR | COMMENTER | VIEWER`. Không ai cấp được OWNER, và không đổi/xóa được OWNER.
- `POST /invitations/accept` thì **mọi user đăng nhập** gọi được (không cần là OWNER), nhưng email đăng nhập phải trùng email được mời.

```ts
type Member = { userId: string; email: string; displayName: string; avatarUrl: string | null; role: Role };
type ShareLink = { id: string; token: string; role: Role; expiresAt: string | null; createdAt: string };
type Invitation = { id: string; email: string; role: Role; expiresAt: string; createdAt: string };  // hạn 7 ngày
```

### 3.4 Lịch sử phiên bản (snapshot)

| Method + Path | Ai | Thành công |
|---|---|---|
| `GET /boards/:boardId/snapshots` | Thành viên | `200 SnapshotMeta[]` (100 bản mới nhất, `seq` giảm dần) |
| `GET /boards/:boardId/snapshots/:snapshotId` | Thành viên | `200 SnapshotMeta & { data: { formatVersion: 1, elements: ElementState[] } }` |
| `POST /boards/:boardId/snapshots/:snapshotId/restore` | OWNER, EDITOR | `200 { seq }` + socket `BoardReset { seq }` cho cả phòng |

```ts
type SnapshotMeta = { id: string; seq: number; label: string | null; createdAt: string };
// label = 'before-restore' cho bản BE tự chụp ngay trước khi khôi phục (để hoàn tác việc khôi phục nhầm)
```

BE tự chụp mỗi 5 phút, chỉ chụp bảng có thay đổi. FE không cần nút "Lưu": mọi op đã được ghi DB ngay.

### 3.5 Ảnh (asset)

| Method + Path | Ai | Body | Thành công | Lỗi |
|---|---|---|---|---|
| `POST /boards/:boardId/assets` | OWNER, EDITOR | `multipart/form-data`, field **`file`**, ≤ 10 MB, PNG/JPEG/GIF/WebP (BE kiểm nội dung file, không tin đuôi) | `201 { assetId, url, mimeType, sizeBytes }` | `400 INVALID_IMAGE` (field `file`), `413` (code `HTTP_ERROR`) khi quá 10 MB |
| `GET /assets/:assetId` | Ai xem được bảng chứa ảnh | | `200` dữ liệu ảnh, `Cache-Control: private, max-age=31536000, immutable` | `404 ASSET_NOT_FOUND` |

`url` trả về có dạng `/api/v1/assets/{id}` (đường dẫn tương đối). Route này **cần header Authorization**, nên `<img src>` không dùng thẳng được:

```ts
const blobUrlCache = new Map<string, string>();  // assetId không bao giờ đổi nội dung -> cache vĩnh viễn trong phiên
async function imageUrl(assetId: string) {
  if (!blobUrlCache.has(assetId)) {
    const res = await request(`/assets/${assetId}`);           // qua interceptor 2.5
    blobUrlCache.set(assetId, URL.createObjectURL(await res.blob()));
  }
  return blobUrlCache.get(assetId)!;
}
```

Upload giới hạn 30 request/phút.

### 3.6 Bình luận (comment)

| Method + Path | Ai | Body | Thành công |
|---|---|---|---|
| `GET /boards/:boardId/comments` | Thành viên | | `200 Comment[]` (cũ → mới, tối đa 1000) |
| `POST /boards/:boardId/comments` | OWNER, EDITOR, COMMENTER | xem bên dưới | `201 Comment` + socket `CommentAdded` |
| `PATCH /boards/:boardId/comments/:commentId` | như trên | `{ body?, resolved? }` (ít nhất một) | `200 Comment` + socket `CommentUpdated` |
| `DELETE /boards/:boardId/comments/:commentId` | Tác giả hoặc OWNER | | `204` + socket `CommentDeleted { id }` |

Body tạo comment:

```ts
// Comment gốc: gắn vào ĐÚNG MỘT chỗ, hoặc một element, hoặc một điểm (x, y) trên bảng
{ body: string /*1-5000, cắt khoảng trắng*/, elementId: string, mentions?: string[] }
{ body: string, x: number, y: number, mentions?: string[] }
// Trả lời: chỉ có parentId, KHÔNG gắn chỗ nào. Chỉ một tầng: trả lời một câu trả lời thì gửi parentId của comment GỐC
{ body: string, parentId: string, mentions?: string[] }
// mentions: danh sách userId được @ (tối đa 50). BE KHÔNG tự tách "@Tên" trong body
```

Luật:

- **Sửa nội dung:** chỉ tác giả. Người khác sửa → `403 NOT_COMMENT_AUTHOR`.
- **Đánh dấu đã xử lý / mở lại** (`resolved: true/false`): ai bình luận được đều làm được.
- **Xóa comment gốc:** các câu trả lời bị xóa theo, nhưng socket chỉ báo `CommentDeleted { id }` của comment gốc. FE tự bỏ luôn các comment có `parentId === id`.
- **Lỗi:** `400 INVALID_PARENT_COMMENT` (parent không phải comment gốc của cùng bảng), `404 COMMENT_NOT_FOUND`.

```ts
type Comment = {
  id: string; boardId: string; parentId: string | null;
  elementId: string | null; x: number | null; y: number | null;
  body: string; resolvedAt: string | null; createdAt: string;
  author: { id: string; displayName: string; avatarUrl: string | null };
};
```

### 3.7 Thông báo (notification)

| Method + Path | Query | Thành công |
|---|---|---|
| `GET /notifications` | `unread=true` (chỉ chưa đọc) hoặc bỏ trống | `200 { items: Notification[], unread: number }` (50 cái mới nhất; `unread` = tổng số chưa đọc) |
| `POST /notifications/:id/read` | | `204` (gọi lại nhiều lần vẫn được) |
| `POST /notifications/read-all` | | `204` |

```ts
type Notification = {
  id: string;
  type: 'MENTION' | 'COMMENT_REPLY';      // enum còn BOARD_INVITATION, ROLE_CHANGED nhưng BE chưa tạo 2 loại này
  actorId: string | null; boardId: string | null; commentId: string | null;
  data: { boardTitle: string; authorName: string; excerpt: string };  // chụp lúc tạo, hiển thị thẳng
  readAt: string | null; createdAt: string;
};
```

Ai nhận thông báo:

- Người được @ (nếu là thành viên bảng) → `MENTION`.
- Tác giả comment gốc khi có người trả lời → `COMMENT_REPLY`.
- Không ai tự nhận thông báo từ hành động của chính mình.

Thông báo mới đến realtime qua socket `NotificationCreated` (mục 5.2).

### 3.8 Khác

`GET /health` (không prefix, không cần đăng nhập) → `{ status: 'ok' }`.

---

## 4. Socket.IO: kết nối và vòng đời

Dùng `socket.io-client` 4.x.

### 4.1 Một socket cho cả phiên làm việc

- **Mỗi tab mở đúng một socket**, kết nối ngay sau khi đăng nhập, sống suốt phiên. Lý do: thông báo (`NotificationCreated`) đến qua socket ở **bất kỳ trang nào**, kể cả khi chưa mở bảng.
- **Một socket chỉ ở một bảng tại một thời điểm.** `JoinBoard` bảng B khi đang ở bảng A thì BE tự rời A.
- **Không có sự kiện `LeaveBoard`.** Rời trang bảng mà không vào bảng khác thì làm `socket.disconnect(); socket.connect();` để BE gỡ khỏi phòng và báo `UserLeft` cho người khác.

```ts
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: (cb) => cb({ token: getAccessToken() }),  // DẠNG HÀM: mỗi lần nối lại lấy token mới nhất
  transports: ['websocket'],                       // bắt buộc khi BE chạy nhiều node (không sticky session)
});
```

**Đừng** truyền token qua header `Authorization` hay query: BE chỉ đọc `handshake.auth.token`.

### 4.2 Bắt tay thất bại

Token thiếu, sai hoặc hết hạn → sự kiện `connect_error` với `err.message === 'unauthorized'`. Xử lý: refresh token (2.5) rồi `socket.connect()`. Refresh thất bại thì về trang login.

### 4.3 Socket tự bị cắt mỗi khi access token hết hạn (khoảng 15 phút)

BE hẹn giờ theo `exp` của token **lúc bắt tay**. Tới hạn thì phát `AuthExpired` rồi ngắt. Refresh token ở FE **không** kéo dài được socket đang mở, nên việc này xảy ra đều đặn. FE phải nối lại êm, không hiện thông báo "mất kết nối":

```ts
socket.on('AuthExpired', async () => {
  await refreshOnce();            // lấy access token mới
  socket.connect();               // auth dạng hàm -> dùng token mới
  // sau 'connect': JoinBoard lại kèm lastSeq (mục 7.10)
});
```

### 4.4 Phân biệt các kiểu ngắt kết nối

| Nguyên nhân | `disconnect` reason | Client tự nối lại? | FE làm gì |
|---|---|---|---|
| Rớt mạng, server restart/deploy | `transport close` / `ping timeout` | Có | Hiện "Đang kết nối lại…". Sau `connect` thì JoinBoard lại kèm `lastSeq` |
| `AuthExpired` | `io server disconnect` | **Không** | Mục 4.3 |
| `AccessChanged` (bị đổi quyền, bị xóa, link thu hồi, bảng bị xóa) | `io server disconnect` | **Không** | Mục 7.14 |
| Spam quá giới hạn (mục 9) | `io server disconnect` | **Không** | Lỗi FE (gửi quá nhanh). Log lại, `socket.connect()` |
| FE gọi `socket.disconnect()` | `io client disconnect` | Không | |

Socket.IO-client tự nối lại **chỉ** khi không phải server hay client chủ động ngắt. Mọi trường hợp `io server disconnect` FE phải tự gọi `socket.connect()`.

### 4.5 Lỗi trên socket

Có 3 dạng lỗi trên socket, FE phải xử lý cả 3:

1. **Ack `{ ok: false, reason }`**: lỗi nghiệp vụ, cách thông thường. Luôn gửi bằng `socket.timeout(5000).emitWithAck(...)` cho các sự kiện có ack.
2. **Sự kiện `exception`**: payload sai định dạng (sai kiểu, thừa field, quá giới hạn). Payload có dạng `{ errors: [{ code: 'VALIDATION_ERROR', field, message }] }` giống HTTP. **Không có ack** trong trường hợp này, nên `emitWithAck` sẽ hết thời gian chờ. Payload lỗi không cho biết sự kiện nào gây ra, vì vậy hãy validate trước khi gửi (1.3) và luôn nghe `exception` để log.
3. **Hết thời gian chờ ack**: tin bị bỏ do vượt giới hạn tần suất, do payload sai (dạng 2), hoặc do mạng. Với `SubmitOps`, gửi lại cùng `opId` là an toàn (BE chống trùng).

---

## 5. Socket.IO: danh sách sự kiện

### 5.1 Client → Server

| Sự kiện | Payload | Ack (trả về) | Ai gửi được |
|---|---|---|---|
| `JoinBoard` | `{ boardId: uuid, displayName: string(1-50), clientId: uuid, lastSeq?: int≥0, shareToken?: string }` | `{ ok: true, role }` \| `{ ok: false, reason: 'not_found' }` | Mọi user có quyền xem |
| `SubmitOps` | `{ ops: Op[] }` (1–100 op) | xem bên dưới | OWNER, EDITOR |
| `UpdateCursor` | `{ x, y }` (tọa độ **bảng**) | không | OWNER, EDITOR, COMMENTER |
| `UpdateViewport` | `{ x, y, zoom }` (zoom 0.01–100) | không | như trên |
| `UpdateSelection` | `{ elementIds: string[] (≤1000), editingElementId?: string \| null }` | `{ ok: true }` \| `{ ok: false, reason: 'being_edited', by: userId }` \| `{ ok: false, reason: 'not_joined' }` | như trên |
| `SendEphemeral` | `{ kind, payload }` (bảng bên dưới) | không | như trên |
| `Ping` | `{ clientTime: number }` | không (server phát sự kiện `Pong`) | mọi socket |

Ack của `SubmitOps`:

```ts
type SubmitOpsAck =
  | {
      ok: true;
      applied: { opId: string; seq: number }[];      // đã lưu lần này
      rejected: { opId: string; reason: RejectReason }[];
      duplicates: { opId: string; seq: number }[];   // đã lưu từ lần gửi trước (gửi lại): coi như applied
    }
  | { ok: false; reason: 'not_joined' | 'forbidden' | 'not_found' | 'shutting_down' | 'internal' };
```

| `reason` khi `ok: false` | FE làm gì |
|---|---|
| `not_joined` | Socket chưa JoinBoard (ví dụ vừa nối lại). JoinBoard xong thì gửi lại lô |
| `forbidden` | Vai trò không được sửa. Không gửi lại; tắt công cụ vẽ |
| `not_found` | Bảng đã bị xóa. Rời bảng |
| `shutting_down` | Node đang tắt. Giữ hàng đợi, nối lại sẽ sang node khác, rồi gửi lại |
| `internal` | Lỗi server. Thử lại sau vài giây (cùng `opId`) |

`SendEphemeral` (không lưu, chỉ chuyển cho người khác):

| `kind` | `payload` | Dùng cho |
|---|---|---|
| `laser` | `{ x, y }` | Bút laser, vệt mờ dần ~1 giây |
| `emote` | `{ emoji: string(1-16), x, y }` | Emoji bay |
| `cursorChat` | `{ text: string(≤100) }` | Chat cạnh con trỏ, ẩn sau vài giây |
| `dragPreview` | `{ elementIds: string[], dx, dy }` | Người khác thấy hình đang được kéo |
| `strokeProgress` | `{ elementId, points: [x, y][] (≤200) }` | Người khác thấy nét đang vẽ dở. Gửi **khúc điểm mới** mỗi ~50 ms |

### 5.2 Server → Client

| Sự kiện | Gửi cho | Payload |
|---|---|---|
| `BoardState` | Người vừa JoinBoard (lần đầu, hoặc không phát lại được) | `{ lastSeq, elements: ElementState[] (đã sắp theo zIndex), users: PresenceUser[], selections: Selection[] }` |
| `MissedOps` | Người JoinBoard lại có `lastSeq` | `{ ops: AppliedOp[], users, selections }` |
| `OpsApplied` | Cả phòng, **kể cả người gửi** | `AppliedOp[]` (**mảng trần**, không bọc object) |
| `OpRejected` | Chỉ người gửi | `{ opId, reason: RejectReason, current?: ElementState }` |
| `UserJoined` | Người khác trong phòng | `PresenceUser` (chỉ khi đó là tab **đầu tiên** của người này) |
| `UserLeft` | Cả phòng | `{ userId }` (khi tab **cuối cùng** của người đó rời) |
| `CursorMoved` | Người khác | `{ userId, clientId, x, y }` |
| `ViewportChanged` | Người khác | `{ userId, clientId, x, y, zoom }` |
| `SelectionChanged` | Người khác | `{ userId, clientId, elementIds, editingElementId: string \| null }` |
| `Ephemeral` | Người khác | `{ userId, clientId, kind, payload }` |
| `BoardRenamed` | Cả phòng | `{ title }` |
| `BoardReset` | Cả phòng | `{ seq }` (vừa khôi phục phiên bản → tải lại cả bảng) |
| `CommentAdded` / `CommentUpdated` | Cả phòng, kể cả người gửi | `Comment` |
| `CommentDeleted` | Cả phòng | `{ id }` |
| `NotificationCreated` | Mọi tab của người nhận (ở trang nào cũng nhận) | `Notification` |
| `AccessChanged` | Người bị ảnh hưởng, ngay trước khi bị ngắt | `{ reason: 'role_changed' \| 'removed' \| 'link_revoked' \| 'board_deleted' }` |
| `AuthExpired` | Socket có token tới hạn | (không payload) |
| `Pong` | Người gửi Ping | `{ clientTime, serverTime }` |
| `exception` | Người gửi payload sai | `{ errors: ApiError[] }` |

```ts
type PresenceUser = { userId: string; clientId: string; displayName: string; color: string };
// color do BE tính từ userId (cùng người = cùng màu ở mọi tab/máy). users đã gom theo userId (mỗi người 1 dòng).
type Selection = { userId: string; clientId: string; elementIds: string[]; editingElementId: string | null };
```

Hai lưu ý cho `CursorMoved`, `ViewportChanged`, `Ephemeral`:

- Hiển thị theo **`clientId`** (mỗi tab một con trỏ), lấy tên và màu theo `userId` từ danh sách `users`.
- `CursorMoved` và `ViewportChanged` là tin "volatile": có thể mất vài tin. Không sao, tin sau đè lên tin trước.

---

## 6. Element và op: mô hình dữ liệu của bảng

### 6.1 Nguyên tắc

- **FE không bao giờ gửi "trạng thái bảng".** FE chỉ gửi **op** (thao tác): `add`, `update`, `delete`, `restore`, `reorder`, `clear`.
- **Server là trọng tài.** Server cấp `seq` (số thứ tự toàn bảng), tăng `version` của element, rồi phát kết quả cuối (`OpsApplied`) cho cả phòng. **Kết quả server phát là sự thật**, FE ghi đè bản tạm của mình bằng nó.
- **Mọi tọa độ là tọa độ bảng**, không phải tọa độ màn hình: `màn hình = (bảng − viewport) × zoom`. Viewport là của riêng mỗi người, không lưu server.

### 6.2 ElementState (server trả về)

```ts
type ElementType = 'freedraw' | 'rect' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'text' | 'sticky' | 'frame' | 'image';

type ElementState = {
  id: string;
  type: ElementType;
  data: Record<string, unknown>;   // các trường riêng theo type (6.3)
  zIndex: string;                  // thứ tự lớp, do SERVER cấp
  version: number;                 // tăng mỗi lần đổi; dùng làm baseVersion
  isDeleted: boolean;              // xóa mềm: true thì không vẽ, nhưng giữ để restore
  locked: boolean;
  groupId: string | null;
  frameId: string | null;
  updatedBy: string;               // userId người sửa cuối
};
```

**Sắp lớp theo `zIndex`** bằng phép so sánh chuỗi thường của JS (`a.zIndex < b.zIndex`). **Không dùng `localeCompare`**: khóa có cả chữ hoa và chữ thường, `localeCompare` sắp sai thứ tự. Lớn hơn thì nằm trên.

### 6.3 `data` theo từng loại

Ký hiệu dùng trong bảng:

- `coord`: số trong khoảng [−10⁷, 10⁷]
- `size`: số trong khoảng [0, 10⁷]
- `opacity`: số trong khoảng 0–1
- `color`: `#rrggbb`, `#rrggbbaa` hoặc `'transparent'`
- `points`: mảng `[x, y]`, **tương đối với `(x, y)`** của element

Mọi trường trong bảng đều **bắt buộc**. Có khóa lạ → bị từ chối.

| type | Trường của `data` |
|---|---|
| `freedraw` | `x, y: coord`, `points` (1–5000 điểm), `strokeColor: color`, `strokeWidth: 0.5–100`, `opacity` |
| `rect`, `ellipse`, `diamond` | `x, y: coord`, `width, height: size`, `angle: number` (radian), `strokeColor, fillColor: color`, `strokeWidth: 0–100`, `strokeStyle: 'solid' \| 'dashed'`, `opacity` |
| `line`, `arrow` | `x, y`, `points` (2–5000 điểm), `strokeColor`, `strokeWidth: 0.5–100`, `strokeStyle`, `opacity`, `startBinding, endBinding: { elementId } \| null` (**phải gửi `null`**, không được bỏ trống), `arrowhead: 'none' \| 'arrow' \| 'triangle'` (ở điểm cuối) |
| `text` | `x, y`, `width: size`, `text: string (≤10.000, rỗng được)`, `fontSize: 1–500`, `color`, `align: 'left' \| 'center' \| 'right'` |
| `sticky` | `x, y`, `width, height`, `text (≤10.000)`, `color` |
| `frame` | `x, y`, `width, height`, `name: string (≤100)` |
| `image` | `x, y`, `width, height`, `angle`, `assetId: uuid` (ảnh đã upload vào **đúng bảng này**) |

### 6.4 Các loại op (client gửi)

```ts
type Op =
  | { type: 'add'; opId: string; element: { id: string; type: ElementType; data: object; groupId?: string | null; frameId?: string | null } }
  | { type: 'update'; opId: string; elementId: string; baseVersion: number; patch: Record<string, unknown> }
  | { type: 'delete'; opId: string; elementId: string }
  | { type: 'restore'; opId: string; elementId: string }           // undo một lần xóa
  | { type: 'restore'; opId: string; clearSeq: number }            // undo "xóa sạch bảng"
  | { type: 'reorder'; opId: string; elementId: string; position: 'front' | 'back' | 'forward' | 'backward' }
  | { type: 'clear'; opId: string };                               // PHẢI là op duy nhất trong lô
```

Luật quan trọng của op:

- **`add`:** `element` chỉ được có `id, type, data, groupId?, frameId?`. Gửi kèm `zIndex`, `version`... → lỗi định dạng, **cả lô** bị từ chối. Element mới luôn nằm trên cùng. `id` đã tồn tại (kể cả element đã xóa mềm) → `already_exists`.
- **`update.patch`:**
  - Patch **phẳng**: chứa thẳng tên trường của `data` (`{ x: 10, strokeColor: '#ff0000' }`), **không** bọc trong `data: {...}`.
  - Ngoài các trường của `data`, patch chỉ được thêm 3 khóa meta: `locked`, `groupId`, `frameId`.
  - Patch là **merge nông**: gửi `points` là thay **cả mảng**.
  - Không đổi được `type`, `id`, `zIndex`, `version`. Khóa lạ hoặc giá trị sai → `invalid_patch`. Patch rỗng → `empty_patch`.
- **`update.baseVersion`:** = `version` **đã được server xác nhận** của element lúc bạn sửa. **Không** tự tăng ở FE: gửi số lớn hơn version trên server → `invalid_base_version`. Gửi số nhỏ hơn thì vẫn được áp: đó là luật last-write-wins (LWW), xem 7.4.
- **`delete`:** xóa mềm.
- **`reorder`:** server tự tính `zIndex` mới. Đã ở trên cùng mà bấm "lên trên" → `no_change`.
- **`clear`:**
  - Xóa mọi element **chưa khóa**. Element đang khóa (ví dụ ảnh nền) được giữ lại.
  - Seq của op clear (lấy từ ack hoặc từ `OpsApplied`) là thứ cần để undo.
  - **Hỏi xác nhận trước khi gửi**: việc này ảnh hưởng mọi người trong phòng.
- **Mỗi op được xét riêng.** Op hỏng bị từ chối nhưng các op khác trong lô vẫn được lưu. Op sau trong cùng lô thấy kết quả của op trước.

### 6.5 AppliedOp (server phát trong `OpsApplied` / `MissedOps`)

```ts
type AppliedOp =
  | { opId: string; seq: number; type: 'add' | 'update' | 'delete' | 'restore' | 'reorder'; element: ElementState }  // element = trạng thái CUỐI
  | { opId: string; seq: number; type: 'clear'; clearedIds: string[] }
  | { opId: string; seq: number; type: 'restore'; clearSeq: number; elements: ElementState[] };  // undo clear
```

Áp vào store:

- Op có `element`: **thay** element cùng id bằng `element`. Nếu `isDeleted: true` thì ẩn đi. Sắp lại lớp nếu `zIndex` đổi.
- `clear`: đánh dấu xóa mọi id trong `clearedIds`.
- `restore` có `elements`: thêm hoặc thay từng element trong mảng.

### 6.6 RejectReason

| reason | Nghĩa | FE làm gì |
|---|---|---|
| `already_exists` | `add` trùng id | Lỗi FE: sinh id bằng UUID |
| `not_found` | Element không tồn tại (hoặc `clearSeq` sai / quá cũ) | Bỏ thay đổi tạm |
| `deleted` | Element đã bị (người khác) xóa | Bỏ thay đổi tạm, ẩn element |
| `not_deleted` | `restore` element chưa bị xóa | Undo: bỏ qua lượt này |
| `locked` | Element đang khóa | Bỏ thay đổi, hiện icon khóa |
| `invalid_base_version` | baseVersion > version server | Lỗi FE |
| `empty_patch`, `invalid_patch`, `invalid_data` | Patch/data sai | Lỗi FE: validate trước khi gửi |
| `no_change` | Reorder không đổi gì | Bỏ qua |
| `asset_not_found` | `assetId` không thuộc bảng này | Upload lại |
| `being_edited` | Sửa `text` của ô người khác đang gõ (7.6) | Bỏ thay đổi chữ |
| `unsupported_op` | | Lỗi FE |

`OpRejected.current` (nếu có) là trạng thái thật trên server. FE dùng nó để trả màn hình về đúng.

---

## 7. Use case: FE phải xử lý thế nào

### 7.1 Trang "Bảng của tôi"

- `GET /boards?search=` (debounce ô tìm kiếm ~300 ms). Hiện `title`, `updatedAt`, `role`.
- Nút "Tạo bảng" → `POST /boards` → điều hướng `/b/{id}`.
- Đổi tên / xóa: chỉ hiện khi `role === 'OWNER'`. Xóa thì hỏi xác nhận.
- Danh sách chỉ có bảng mình là **thành viên**. Bảng vào bằng link chia sẻ không nằm ở đây.

### 7.2 Mở bảng (`/b/:boardId`)

```ts
// Gắn listener TRƯỚC khi emit: BoardState/MissedOps tới TRƯỚC ack
socket.on('BoardState', (s) => { store.reset(s.elements); lastSeq = s.lastSeq; presence.reset(s.users, s.selections); });
socket.on('MissedOps', (m) => { m.ops.forEach(applyRemote); presence.reset(m.users, m.selections); });

const ack = await socket.timeout(10_000).emitWithAck('JoinBoard', {
  boardId,
  displayName: me.displayName,
  clientId: TAB_CLIENT_ID,              // crypto.randomUUID() một lần mỗi tab (giữ trong bộ nhớ)
  lastSeq: store.hasData ? lastSeq : undefined,
  shareToken: query.share,              // chỉ khi vào bằng link chia sẻ
});
if (!ack.ok) return showNotFound();     // không có bảng HOẶC không có quyền (BE trả như nhau)
role = ack.role;                         // quyết định công cụ nào được bật (mục 8)
```

- Lấy title: thành viên gọi `GET /boards/:boardId` (trả `{ title, role }`). Người vào bằng link xem [11](#11-be-chưa-có--hạn-chế-đã-biết).
- Tải song song: `GET /boards/:boardId/comments`.

### 7.3 Vẽ / sửa: cập nhật lạc quan + hàng đợi chờ xác nhận

Đây là phần lõi. Đề xuất cấu trúc store:

```ts
confirmed: Map<id, ElementState>   // CHỈ đổi khi server phát (BoardState / OpsApplied / MissedOps / OpRejected.current)
pending:   Op[]                    // op đã tạo ở FE, chưa thấy trong OpsApplied
lastSeq:   number                  // seq lớn nhất đã áp
// Màn hình = confirmed + áp lần lượt các op trong pending lên trên (tính lại khi một trong hai đổi)
```

Luồng:

1. **Người dùng thao tác** → tạo op (`opId = crypto.randomUUID()`) → đẩy vào `pending` → màn hình đổi **ngay**.
2. **Mỗi ~50 ms** gom op chưa gửi thành một lô (≤ 100 op, < ~90 KB) → `SubmitOps`.
3. **`OpsApplied`** (của mình hoặc người khác), với mỗi op:
   - `op.seq <= lastSeq` → **bỏ qua**: đã có (trùng lúc JoinBoard).
   - Ngược lại → áp vào `confirmed`, đặt `lastSeq = op.seq`, xóa khỏi `pending` op có cùng `opId`.
   - Thấy `op.seq > lastSeq + 1` (hở số) → đã lỡ tin → JoinBoard lại kèm `lastSeq`.
4. **`OpRejected`** → xóa op khỏi `pending`. Nếu có `current` thì đặt `confirmed[id] = current`. Màn hình tự quay về đúng.
5. **Ack:** các op trong `duplicates` coi như đã xác nhận (xóa khỏi pending). Ack hết thời gian chờ thì **gửi lại nguyên lô, cùng `opId`**: BE không áp hai lần.

Không lưu từng bước kéo chuột. Kéo hình thì:

- Trong lúc kéo: chỉ gửi `SendEphemeral dragPreview`.
- Khi thả chuột: **một** op `update { x, y }` cho mỗi hình.

Gõ chữ: debounce 300 ms rồi mới gửi `update { text }`.

### 7.4 Hai người cùng sửa một hình (LWW)

- A kéo hình, B đổi màu, cùng lúc → **cả hai được giữ**, vì patch chỉ chứa trường thay đổi.
- A và B cùng đổi `x` → op tới server sau thắng.
- FE không cần làm gì thêm ngoài 7.3: `OpsApplied` mang `element` cuối cùng, cứ ghi đè.

### 7.5 Undo / Redo: chỉ hoàn tác việc của mình

Undo **không** quay bảng về trạng thái trước (làm vậy sẽ xóa luôn việc người khác vừa làm). Undo là **gửi một op ngược lại**. Ngăn xếp undo nằm ở FE, mất khi F5 là chấp nhận được.

| Op đã gửi | Op ngược (đẩy vào ngăn undo **lúc gửi**) |
|---|---|
| `add` | `delete { elementId }` |
| `delete` | `restore { elementId }` |
| `restore { elementId }` | `delete { elementId }` |
| `update patch {x: 300}` | `update patch {x: <giá trị cũ>}` (chụp giá trị cũ của **đúng các khóa** trong patch trước khi sửa) |
| `clear` | `restore { clearSeq: <seq của op clear> }` (seq lấy từ ack `applied`) |
| `reorder` | Không có op ngược chính xác (server tự tính zIndex). Đề xuất: `forward` ↔ `backward`; `front`/`back` không đưa vào undo |

- Bấm Ctrl+Z: lấy op ngược, gửi như op thường (`opId` mới, `baseVersion` = version đã xác nhận **hiện tại**), đẩy op ngược của nó vào ngăn redo.
- Undo bị từ chối (`deleted`, `not_found`, `not_deleted`) → bỏ qua, sang mục kế tiếp.
- Một thao tác của người dùng sinh nhiều op (nhóm, di chuyển nhiều hình, xóa hình + gỡ binding mũi tên) → gói thành **một mục** undo.

### 7.6 Sửa chữ (text, sticky) và khóa mềm

1. Người dùng nhấp đúp vào ô chữ → `emitWithAck('UpdateSelection', { elementIds: [id], editingElementId: id })`.
2. Ack `{ ok: false, reason: 'being_edited', by }` → **không** vào chế độ sửa, hiện "‹tên của `by`› đang sửa".
3. Ack `ok` → vào chế độ sửa, gửi `update { text }` (debounce 300 ms).
4. Thoát sửa → `UpdateSelection { elementIds: [...], editingElementId: null }`.
5. Ô người khác đang sửa (`SelectionChanged.editingElementId`) → vẽ viền màu của họ kèm tên, chặn vào chế độ sửa.

Khóa tự mở khi người kia rời bảng hoặc mất kết nối (BE phát `SelectionChanged` rỗng cho họ). Op sửa `text` của ô người khác đang giữ → `OpRejected { reason: 'being_edited' }`.

### 7.7 Chọn, nhóm, khóa, thứ tự lớp, style

- **Viền chọn:** mỗi lần chọn khác đi → `UpdateSelection { elementIds }`. Hiện viền màu cho `SelectionChanged` của người khác. Người vào sau nhận `selections` trong `BoardState`.
- **Nhóm** = một lô `update { groupId: <id mới> }` cho mọi element đã chọn. Bỏ nhóm = `groupId: null`. Bấm một element có `groupId` thì FE chọn cả nhóm.
- **Khóa:** `update { locked: true }`. Element đang khóa chỉ nhận đúng patch `{ locked: false }` (gửi `{ locked: false, x: 5 }` vẫn bị `locked`). FE chặn kéo/xóa element đang khóa.
- **Thứ tự lớp:** `reorder { position }`.
- **Style** (viền, nền, nét đứt, độ trong suốt): `update` với trường tương ứng.

### 7.8 Mũi tên dính hình, frame, copy/paste, tẩy

- **Mũi tên:**
  - Chỉ lưu `startBinding/endBinding = { elementId }`. Lúc vẽ, FE tự tính điểm đầu/cuối từ vị trí hiện tại của hình được dính. Hình di chuyển thì mũi tên tự theo, **không gửi op**.
  - Xóa hình → cùng lô, gửi `update { startBinding: null }` (hoặc `endBinding`) cho các mũi tên dính vào hình đó.
- **Frame:**
  - Element con có `frameId`. Kéo frame = một lô `update` cho frame **và** mọi element con.
  - Xóa frame thì FE tự chọn: xóa luôn con, hoặc gửi `frameId: null` cho con.
- **Copy/paste/nhân bản:** `add` với **id mới** cho từng element.
- **Tẩy:** chạm nét nào thì `delete` cả nét đó.

### 7.9 Vẽ tự do và nét vẽ dở

- **Nhả chuột** → một op `add freedraw`. Trước khi gửi: rút gọn điểm (Ramer–Douglas–Peucker), làm tròn tọa độ 1–2 chữ số thập phân, giữ ≤ 5000 điểm và cả tin < 100 KB.
- **Trong lúc vẽ:** gửi `SendEphemeral strokeProgress { elementId, points: <các điểm MỚI từ lần gửi trước> }` mỗi ~50 ms.
- **Bên nhận:** nối các khúc theo `clientId + elementId` để vẽ nét tạm. Nét tạm bị gỡ khi `OpsApplied` có `add` cùng `elementId`, hoặc sau vài giây không có khúc mới.

### 7.10 Mất mạng, nối lại, gửi bù

1. Mất mạng: người dùng vẫn vẽ, op nằm trong `pending`. Hiện badge "Ngoại tuyến".
2. `socket.on('connect')` → `JoinBoard` kèm `lastSeq`.
3. Server trả **một trong hai**:
   - `MissedOps`: áp từng op như `OpsApplied`. Op của chính mình nằm trong đó thì tự rời `pending` theo `opId`.
   - `BoardState` (lỡ > 1000 op, có khôi phục phiên bản, hoặc op cũ đã bị dọn): **thay** toàn bộ `confirmed`, giữ `pending`.
4. Gửi lại toàn bộ `pending` chưa xác nhận, **giữ nguyên `opId`**. Op nào đã lưu trước khi rớt mạng sẽ về trong `duplicates`.

Có thể nhận `OpsApplied` với `seq <= lastSeq` ngay sau JoinBoard: đó là bản trùng, bỏ qua (luật 7.3 bước 3).

### 7.11 Ảnh

1. Chọn/kéo-thả/dán ảnh → `POST /boards/:id/assets` (multipart, field `file`) → `{ assetId }`.
2. `add` element `image { x, y, width, height, angle: 0, assetId }`.
3. Hiển thị qua `fetch` + `createObjectURL` (3.5). Trong lúc chờ tải, hiện khung xám.
4. **Ảnh không bao giờ đi qua socket.**

### 7.12 Bình luận

- **Mở bảng:** `GET comments`, gom theo `parentId` thành luồng. Comment gốc vẽ bong bóng tại element (`elementId`) hoặc điểm (`x, y`). Element bị xóa thì bong bóng còn tọa độ cuối hoặc ẩn: FE tự chọn.
- **Tạo/sửa/xóa:** REST. **Đừng** tự thêm vào danh sách từ response *và* từ `CommentAdded`: gộp theo `id`, vì socket phát cho cả người gửi.
- **@mention:** FE dựng danh sách gợi ý, gửi `mentions: userId[]`. Lấy danh sách người từ đâu thì xem hạn chế ở mục 11.
- **"Đã xử lý":** `PATCH { resolved: true }`. Có bộ lọc ẩn/hiện comment đã xử lý.
- **Quyền:** hiện nút "Sửa" chỉ với comment của mình. "Xóa": của mình, hoặc mọi comment nếu là OWNER.

### 7.13 Thông báo

- **Sau đăng nhập:** `GET /notifications` → badge = `unread`.
- **`NotificationCreated`:** thêm lên đầu danh sách, `unread += 1`, có thể hiện toast.
- **Bấm một thông báo:** `POST /notifications/:id/read` → điều hướng `/b/{boardId}` → mở luồng comment `commentId`.
- **"Đánh dấu đã đọc hết":** `POST /notifications/read-all`.

### 7.14 Bị đổi quyền / bị đá (`AccessChanged`)

Sự kiện này tới ngay trước khi server ngắt socket:

| reason | FE làm gì |
|---|---|
| `role_changed` | `socket.connect()` → JoinBoard lại (không cần xóa store, gửi kèm `lastSeq`) → dùng `role` mới trong ack, cập nhật công cụ. Báo "Quyền của bạn đã đổi thành …" |
| `removed` | Báo "Bạn đã bị xóa khỏi bảng" → về trang danh sách. `socket.connect()` để vẫn nhận thông báo |
| `link_revoked` | Báo "Link chia sẻ đã bị thu hồi" → rời bảng, `socket.connect()` |
| `board_deleted` | Báo "Bảng đã bị xóa" → về danh sách, `socket.connect()` |

### 7.15 Lịch sử phiên bản

- **Danh sách:** `GET /boards/:id/snapshots`, hiện theo `createdAt`. Bản có `label === 'before-restore'` thì ghi chú "Trước khi khôi phục".
- **Xem một bản:** `GET .../snapshots/:snapshotId` → vẽ `data.elements` ở **chế độ chỉ đọc** (canvas riêng, không gửi op).
- **Khôi phục** (OWNER/EDITOR, hỏi xác nhận): `POST .../restore`.
- **Mọi người** (kể cả người bấm) nhận `BoardReset`:
  1. Xóa `pending` và ngăn undo/redo (chúng tính trên trạng thái cũ).
  2. JoinBoard lại **không kèm `lastSeq`** để nhận `BoardState` mới.
  3. Gộp `UserJoined` theo `userId`: JoinBoard lại có thể làm người khác nhận `UserJoined` lần nữa.

### 7.16 Chia sẻ (màn hình của OWNER)

- **Thành viên:** `GET members`, dropdown đổi vai trò (`PATCH`), nút xóa (`DELETE`). Dòng OWNER không có hai nút này.
- **Mời qua email:** form `{ email, role }` → `POST invitations`. Danh sách lời mời đang chờ kèm nút thu hồi.
- **Link chia sẻ:**
  - Tạo: `POST share-links { role, expiresInHours? }`.
  - **FE tự dựng URL**: `${location.origin}/b/${boardId}?share=${link.token}` (tên tham số do FE chọn; BE chỉ cần `shareToken` trong JoinBoard).
  - Có nút copy và nút thu hồi.
  - Token được lưu nguyên bản ở BE, nên `GET share-links` luôn copy lại được.

### 7.17 Nhận lời mời (`/invitations/accept?token=...`)

1. Chưa đăng nhập → lưu `token` (sessionStorage) → đăng nhập hoặc đăng ký. **Email phải trùng email được mời.** Đăng ký mới thì phải xác minh email trước, rồi quay lại.
2. Đã đăng nhập → `POST /invitations/accept { token }` → `{ boardId }` → điều hướng `/b/{boardId}`.
3. `INVITATION_EMAIL_MISMATCH` → "Lời mời này gửi cho email khác. Hãy đăng xuất và đăng nhập đúng email". `INVALID_INVITATION` → "Lời mời đã hết hạn hoặc bị thu hồi".
4. Đã là thành viên mà nhận lời mời: vai trò cũ được giữ nguyên.

### 7.18 Vào bằng link chia sẻ (`/b/:boardId?share=TOKEN`)

1. **Bắt buộc đăng nhập**, vì socket cần JWT. Chưa đăng nhập thì chuyển tới trang login, giữ lại URL để quay về.
2. JoinBoard kèm `shareToken`. Ack trả `role` của link.
3. Nếu người này đã là thành viên thì vai trò thành viên được dùng, không dùng vai trò của link.
4. Người vào bằng link **không phải thành viên**, nên các REST của bảng trả 404. Xem [11](#11-be-chưa-có--hạn-chế-đã-biết) để biết ẩn những gì.

### 7.19 Hiện diện: con trỏ, theo dõi, laser, emote

- **Danh sách online:** `users` từ BoardState/MissedOps, cộng `UserJoined`, trừ `UserLeft`. Gộp theo `userId` (avatar chữ cái đầu + `color`).
- **Con trỏ:**
  - Gửi `UpdateCursor` (tọa độ bảng), throttle ≤ 20 lần/giây.
  - Bên nhận hiển thị theo `clientId` và nội suy mượt 50–100 ms.
  - Ẩn con trỏ khi người đó rời đi (`UserLeft`) hoặc sau vài giây không có tin.
- **Theo dõi người khác:** gửi `UpdateViewport` khi pan/zoom (throttle). Người đang theo dõi đặt viewport của mình theo `ViewportChanged` của người được theo dõi.
- **Laser, emote, cursor chat:** `SendEphemeral`, hiển thị vài giây rồi ẩn.
- **VIEWER** không gửi được presence (BE bỏ qua im lặng). FE không gửi để khỏi tốn băng thông.

### 7.20 Đồng bộ giờ (cho tính năng hẹn giờ sau này)

```ts
socket.emit('Ping', { clientTime: Date.now() });
socket.on('Pong', ({ clientTime, serverTime }) => {
  const now = Date.now();
  clockOffset = serverTime - (clientTime + now) / 2;   // giờ server ≈ Date.now() + clockOffset
});
```

---

## 8. Phân quyền: ẩn/hiện gì theo vai trò

`role` lấy từ ack `JoinBoard` (trong bảng) hoặc `GET /boards` (trang danh sách). BE vẫn kiểm lại mọi thứ. Ẩn nút ở FE chỉ để giao diện đúng, không phải để bảo mật.

| Việc | OWNER | EDITOR | COMMENTER | VIEWER |
|---|:-:|:-:|:-:|:-:|
| Xem bảng, thấy con trỏ người khác | ✓ | ✓ | ✓ | ✓ |
| Gửi con trỏ, viewport, viền chọn, laser, emote | ✓ | ✓ | ✓ | |
| Bình luận (tạo, trả lời, đánh dấu đã xử lý) | ✓ | ✓ | ✓ | |
| Vẽ, sửa, xóa, khóa, upload ảnh | ✓ | ✓ | | |
| Xóa sạch bảng, khôi phục phiên bản | ✓ | ✓ | | |
| Xóa comment của người khác | ✓ | | | |
| Thành viên, lời mời, link chia sẻ, nhật ký | ✓ | | | |
| Đổi tên, xóa bảng | ✓ | | | |

---

## 9. Giới hạn

| Mục | Giới hạn | Vượt thì |
|---|---|---|
| Kích thước một tin socket | 100 KB | **Socket bị đóng** |
| Số op một lô `SubmitOps` | 1–100; `clear` phải đi một mình | `exception`, cả lô bị từ chối |
| Tần suất socket | 30 tin/giây **cho mỗi loại sự kiện**, mỗi socket | Tin bị bỏ im lặng (không ack). Bị bỏ > 100 tin trong 10 giây → bị ngắt |
| Điểm mỗi nét (`freedraw`, `line`, `arrow`) | 5000 | `exception` |
| Điểm mỗi tin `strokeProgress` | 200 | `exception` |
| Chữ (`text`, `sticky`) | 10.000 ký tự | |
| Tên bảng / tên hiển thị | 50 ký tự | |
| Tên frame | 100 ký tự | |
| Comment | 1–5000 ký tự, 50 mention | |
| Ảnh | 10 MB; PNG/JPEG/GIF/WebP (SVG **không** được) | 400 / 413 |
| Tọa độ | [−10⁷, 10⁷]; không NaN/Infinity/null | |
| Danh sách trả về | Bảng 100, comment 1000, thông báo 50, snapshot 100, nhật ký 100/trang | Chưa phân trang (trừ nhật ký) |
| Op cũ | Giữ 30 ngày (những op đã có snapshot bao phủ) | Undo-clear quá 30 ngày → `not_found` |

Nhịp gửi đề xuất ở FE:

- `SubmitOps`: gom mỗi 50 ms (≤ 20 lần/giây).
- Con trỏ: ≤ 20 lần/giây.
- Viewport: ≤ 10 lần/giây.
- `strokeProgress`, `dragPreview`: mỗi ~50 ms.

---

## 10. Mã lỗi

### 10.1 HTTP

| code | Status | Khi nào | FE hiển thị / xử lý |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query/param sai | Lỗi dưới ô theo `field` |
| `UNAUTHORIZED` | 401 | Thiếu/hết hạn access token | Refresh rồi gửi lại (2.5) |
| `INVALID_CREDENTIALS` | 401 | Sai email/mật khẩu | Lỗi form đăng nhập |
| `INVALID_REFRESH_TOKEN` | 401 | Phiên hết hạn / bị thu hồi | Về trang đăng nhập |
| `EMAIL_NOT_VERIFIED` | 403 | Đăng nhập khi chưa xác minh | Nút gửi lại email xác minh |
| `BOARD_FORBIDDEN` | 403 | Vai trò không đủ | Toast; kiểm lại `role` ở FE |
| `NOT_COMMENT_AUTHOR` | 403 | Sửa/xóa comment người khác | Toast |
| `INVITATION_EMAIL_MISMATCH` | 403 | Nhận lời mời bằng email khác | 7.17 |
| `USER_NOT_FOUND` | 404 | Tài khoản đã bị xóa | Đăng xuất |
| `BOARD_NOT_FOUND` | 404 | Bảng không có hoặc không có quyền | Trang "Không tìm thấy bảng" |
| `MEMBER_NOT_FOUND`, `SHARE_LINK_NOT_FOUND`, `INVITATION_NOT_FOUND`, `SNAPSHOT_NOT_FOUND`, `ASSET_NOT_FOUND`, `COMMENT_NOT_FOUND` | 404 | | Tải lại danh sách |
| `NOT_FOUND` | 404 | Route không tồn tại (ví dụ `/auth/google` khi chưa bật Google) | |
| `EMAIL_TAKEN` | 409 | Đăng ký trùng email | Lỗi dưới ô email |
| `CONFLICT` | 409 | Lưới an toàn khi trùng dữ liệu | Toast chung |
| `INVALID_VERIFY_TOKEN`, `INVALID_RESET_TOKEN`, `INVALID_INVITATION` | 400 | Link hỏng/hết hạn | Trang báo link hết hạn |
| `OWNER_ROLE_FIXED` | 400 | Đổi/xóa OWNER | |
| `INVALID_PARENT_COMMENT` | 400 | Trả lời sai | |
| `INVALID_IMAGE` | 400 | Không phải ảnh hợp lệ | Lỗi upload |
| `BAD_REFERENCE` | 400 | Lưới an toàn khi tham chiếu không tồn tại | Toast chung |
| `HTTP_ERROR` | 413… | Ví dụ ảnh > 10 MB | "Ảnh quá lớn (tối đa 10 MB)" |
| `RATE_LIMITED` | 429 | Gửi quá nhanh | "Thử lại sau `details.retryAfterSeconds` giây" |
| `SHUTTING_DOWN` | 503 | Server đang khởi động lại | Thử lại sau vài giây |
| `INTERNAL_ERROR` | 500 | Lỗi server | Toast chung |

### 10.2 Socket

- Ack `JoinBoard`: `not_found`.
- Ack `SubmitOps`: `not_joined`, `forbidden`, `not_found`, `shutting_down`, `internal` (bảng ở 5.1).
- Ack `UpdateSelection`: `being_edited`, `not_joined`.
- Op bị từ chối: bảng 6.6.

---

## 11. BE chưa có / hạn chế đã biết

Những điểm FE cần biết để không mất công tìm. Cần thì báo BE bổ sung.

| Mục | Hiện trạng | FE tạm làm gì |
|---|---|---|
| Đăng nhập Google | Callback chưa phát token | Ẩn nút Google |
| Sửa hồ sơ (tên, avatar, `preferences` như dark mode) | Chưa có API (`PATCH /me` không tồn tại) | Lưu dark mode ở localStorage |
| Đổi mật khẩu khi đang đăng nhập / xem thiết bị đăng nhập / đăng xuất mọi nơi | Chưa có API | Dùng luồng quên mật khẩu |
| Người vào bằng **link chia sẻ** (không phải thành viên) | Chỉ dùng được socket. REST của bảng (`GET /boards/:id`, comments, snapshots, upload, **xem ảnh**) trả 404 | Ẩn bình luận, lịch sử, upload. Ảnh hiện khung giữ chỗ. **Không có tên bảng** (BoardState không kèm title) → hiện "Bảng được chia sẻ" |
| Danh sách thành viên cho @mention | `GET members` chỉ OWNER gọi được | Người khác gợi ý từ danh sách online (`users`) |
| Phân trang | Chỉ nhật ký có (`before`). Danh sách bảng, comment, thông báo, snapshot trả N cái mới nhất | Không làm cuộn vô hạn |
| Thông báo `BOARD_INVITATION`, `ROLE_CHANGED` | Có trong enum nhưng BE chưa tạo | Chỉ xử lý `MENTION`, `COMMENT_REPLY` (vẫn nên có nhánh mặc định) |
| Sửa comment thêm người được @ | Không tạo thông báo mới (chỉ lúc tạo mới báo) | |
| `LeaveBoard` | Không có | `disconnect()` + `connect()` (4.1) |
| Chống mời trùng | Mời một email nhiều lần vẫn tạo nhiều lời mời | Kiểm danh sách lời mời trước khi gửi |
| Chưa làm (trong spec) | Stamp (5.4), đồng hồ đếm ngược chung (5.6), template (5.9), xuất/nhập JSON (7.2) | Xuất PNG/SVG/PDF làm hoàn toàn ở FE |

---

## 12. Thứ tự làm FE đề xuất

Mỗi bước chạy được và kiểm được trước khi sang bước sau.

1. **Khung app + auth.** HTTP client có interceptor (1.1, 2.5). Các trang: đăng ký, kiểm tra email, `/verify-email`, đăng nhập, quên mật khẩu, `/reset-password`. Khởi động app bằng refresh (2.4). Đăng xuất.
   *Xong khi:* F5 vẫn đăng nhập; access token hết hạn thì tự refresh, người dùng không thấy gì.
2. **Trang bảng của tôi.** Liệt kê, tìm kiếm, tạo, đổi tên, xóa (7.1).
3. **Socket + vào bảng.** Kết nối (4.1–4.4), JoinBoard, vẽ `BoardState` (chỉ đọc), danh sách online.
   *Xong khi:* hai trình duyệt cùng mở một bảng thấy nhau online.
4. **Vẽ cơ bản.** Store `confirmed`/`pending`/`lastSeq` (7.3). freedraw + rect/ellipse/diamond, chọn, kéo, xóa.
   *Xong khi:* A vẽ thì B thấy; tắt mạng A rồi bật lại thì không mất nét nào (7.10).
5. **Đủ công cụ.** line/arrow + binding, text/sticky + khóa mềm, frame, nhóm, khóa, thứ tự lớp, style, copy/paste, clear (7.6–7.9).
6. **Undo/redo** (7.5).
7. **Hiện diện:** con trỏ, viền chọn, theo dõi, laser, emote, `strokeProgress`, `dragPreview` (7.19).
8. **Ảnh** (7.11).
9. **Phân quyền ở UI** (8) + `AccessChanged` (7.14) + `AuthExpired` (4.3).
10. **Chia sẻ:** màn hình OWNER, nhận lời mời, vào bằng link (7.16–7.18).
11. **Bình luận + thông báo** (7.12–7.13).
12. **Lịch sử phiên bản + nhật ký** (7.15, `audit-logs`).
13. **Hoàn thiện:** dark mode (localStorage), xuất PNG/SVG, chỉ vẽ element trong viewport khi bảng lớn.
