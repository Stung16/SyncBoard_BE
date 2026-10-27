# SyncBoard — Phân tích thiết kế

Oct 24, 2026 · @Meta Roof Master

## 1. Tổng quan

SyncBoard là bảng trắng nhiều người cùng vẽ theo thời gian thực. Backend viết bằng NestJS (Node.js + TypeScript), realtime qua Socket.IO, database qua Prisma. Toàn bộ thiết kế xoay quanh một ý: **lưu và gửi từng thao tác (operation), không gửi cả bảng**.

**Bốn câu hỏi mà mọi tính năng đều quy về:**

1. **Phòng:** ai đang ở bảng nào, để chỉ gửi tin cho đúng người.
2. **Phát sóng:** một người làm gì thì người khác nhận được ngay.
3. **Lưu trữ:** người vào sau hoặc F5 lấy lại được nội dung.
4. **Xung đột:** hai người sửa cùng một thứ thì nghe theo ai.

**Nguyên tắc thiết kế:**

- **Server là trọng tài.** Client gửi thao tác lên, server kiểm tra, đánh số thứ tự, lưu, rồi mới phát cho mọi người. Không client nào tự quyết.
- **Mọi thứ trên bảng là một "element" có id.** Nét vẽ, hình, chữ, sticky note, ảnh, mũi tên đều cùng một mô hình. Nhờ vậy di chuyển, xóa, khóa, đổi lớp chỉ cần viết một lần.
- **Tách sự kiện lưu và sự kiện tạm.** Thêm hình thì lưu vào DB. Con trỏ, laser, emote thì chỉ phát đi rồi quên, không bao giờ chạm DB.
- **Làm đơn giản trước.** Bắt đầu với dữ liệu trong bộ nhớ và một server. Database, Redis, CRDT chỉ thêm khi thật sự cần.

**Phạm vi:** tài liệu phủ đủ 8 cấp tính năng. Cấp 1, 2, 4 và 6 được phân tích kỹ vì đó là phần backend. Các tính năng thuần giao diện (dark mode, minimap, lưới, phím tắt) chỉ ghi chú ngắn vì backend không phải làm gì.

## 2. Thuật ngữ

Đọc phần này trước. Các phần sau dùng lại những từ này mà không giải thích lại.

| Thuật ngữ | Nghĩa đơn giản | Trong SyncBoard |
| --- | --- | --- |
| WebSocket | Kết nối giữ mở liên tục giữa trình duyệt và server, hai bên gửi tin cho nhau bất cứ lúc nào | Kênh chính để gửi nét vẽ và sự kiện |
| Socket.IO | Thư viện bọc WebSocket lại cho dễ dùng, tự kết nối lại, tự chuyển sang long-polling nếu WebSocket bị chặn. NestJS hỗ trợ sẵn qua `@nestjs/websockets` + `@nestjs/platform-socket.io` | Thay vì tự viết WebSocket thô |
| Gateway | Class trên server gắn `@WebSocketGateway()`. Mỗi method gắn `@SubscribeMessage('TênSựKiện')` nhận một loại tin từ client; gateway cũng gửi tin ngược lại client | `BoardGateway` xử lý mọi sự kiện của bảng |
| Socket / Connection | Một tab trình duyệt đang kết nối. Một người mở 2 tab là 2 socket | Mỗi socket có `socket.id` riêng |
| Room | Nhóm các socket. Gửi cho room là gửi cho tất cả người trong đó | Mỗi bảng là một room, tên là `board:{boardId}` |
| Broadcast | Gửi một tin cho nhiều người cùng lúc | Nét vẽ mới gửi cho cả phòng |
| Presence | Thông tin "ai đang ở đây, đang làm gì" | Danh sách online, con trỏ, ai đang chọn hình nào |
| Element | Một đối tượng trên bảng | Nét vẽ, hình chữ nhật, chữ, sticky note, ảnh, mũi tên |
| Operation (op) | Một thao tác: thêm, sửa, xóa element | Thứ được gửi qua mạng và ghi vào nhật ký |
| Sequence (seq) | Số thứ tự tăng dần do server cấp cho mỗi op của một bảng | Biết op nào trước, op nào sau; người rớt mạng hỏi "gửi tôi mọi op sau số 120" |
| Snapshot | Ảnh chụp toàn bộ trạng thái bảng tại một thời điểm | Vào phòng thì tải snapshot rồi áp các op sau nó, khỏi phải phát lại từ đầu |
| Version | Số đếm của từng element, tăng mỗi lần bị sửa | Phát hiện hai người sửa cùng lúc |
| LWW | Last Write Wins: thao tác đến server sau cùng sẽ thắng | Cách xử lý xung đột đơn giản nhất, đủ dùng |
| CRDT | Cấu trúc dữ liệu tự hợp nhất được mà không cần server phân xử | Nâng cao, chỉ cân nhắc ở cuối |
| Ephemeral | Sự kiện tạm, phát đi rồi bỏ, không lưu | Con trỏ, laser, emote, cursor chat |

## 3. Kiến trúc tổng thể

Server có hai cửa vào và một chỗ xử lý chung. REST dùng cho việc làm một lần cần kết quả trả về; Socket.IO dùng cho luồng liên tục. Cả hai cùng gọi `BoardService`, nên logic kiểm tra và ghi database chỉ nằm ở một chỗ.

&#91;embedded content: kiến trúc SyncBoard · client, server, lưu trữ\]

Gateway chỉ nhận và trả tin, không chứa logic. Logic nằm ở `BoardService` để sau này viết unit test được mà không cần mở kết nối thật.

**Cấu trúc thư mục** (một app NestJS, kiểu modular monolith với `infra/` tách riêng). Cây đầy đủ, lý do chọn và nguồn tham khảo nằm ở [docs/research/nestjs-folder-structure.md](docs/research/nestjs-folder-structure.md).

```
prisma/              schema.prisma, migrations/, seed.ts
src/
  main.ts, app.module.ts
  config/            env.validation.ts
  common/            decorators/ filters/ guards/ pipes/ utils/   (chỉ chứa thứ đã có ≥ 2 module dùng)
  infra/             hạ tầng, không chứa nghiệp vụ
    database/        prisma.module.ts (@Global), prisma.service.ts
    storage/         storage.interface.ts, local-disk.storage.ts, s3.storage.ts (sau này)
    socket/          socket-emitter.service.ts, redis-io.adapter.ts (UC 8.4)
  modules/           nghiệp vụ, mỗi feature một module
    board/           board.controller, board.service, board-locks, operation.service, domain/, dto/
    realtime/        board.gateway, presence-tracker, dto/
    sharing/         board_members + share_links (GĐ4)
    asset/  snapshot/  auth/  user/  comment/
test/                *.e2e-spec.ts   (unit test *.spec.ts đặt cạnh file)
```

- **`board/domain/`** chứa hàm TypeScript thuần cho LWW (mục 7.2), z-index (4.4) và bảng quyền (8.1). Phần này test được mà không cần DB hay NestJS.
- **`board.gateway.ts` nằm trong `realtime/`**, nhận và trả tin rồi gọi `BoardService`.
- **Module khác muốn phát tin realtime thì gọi `SocketEmitter`**, không import gateway. Xem 5.1 ở Cấp 5.
- **Quy tắc phụ thuộc:** gateway/controller → service → `infra/`, chỉ một chiều, không dùng `forwardRef`.

Trong NestJS mọi provider mặc định là **singleton** (một đối tượng dùng chung cho cả ứng dụng), và mọi class ở đây đều nên để vậy. `PresenceTracker`, `BoardLocks` và `SocketEmitter` cần singleton vì giữ dữ liệu bộ nhớ. `BoardService` và `PrismaService` không giữ dữ liệu riêng của từng request nên dùng chung được. Không dùng `Scope.REQUEST`: gateway phải là singleton, và request scope làm chậm mọi request.

## 4. Mô hình dữ liệu và database

Database có ba bảng lõi: `boards`, `elements` (trạng thái hiện tại) và `operations` (nhật ký thao tác). Các bảng còn lại chỉ thêm khi làm tới tính năng tương ứng. Gợi ý dùng PostgreSQL qua Prisma (kiểu `Json` của Prisma lưu thành `jsonb` trên PostgreSQL); giai đoạn đầu có thể dùng SQLite cho nhẹ.

### 4.1 Danh sách bảng

| Bảng | Cột chính | Phục vụ tính năng | Cần từ giai đoạn |
| --- | --- | --- | --- |
| `boards` | id, title, owner\_id, last\_seq, created\_at, updated\_at, deleted\_at | 1.1, 6.2 | 1 |
| `elements` | board\_id, id, type, data (jsonb), z\_index, version, is\_deleted, locked, group\_id, frame\_id, updated\_by, updated\_at | 1.2, 1.6, toàn bộ cấp 2 | 1 |
| `operations` | board\_id, seq, op\_id, type, element\_id, payload (jsonb), actor, created\_at | 4.8, 6.5, 6.6 | 3 |
| `assets` | id, board\_id, storage\_key, mime\_type, size\_bytes, uploaded\_by, created\_at | 2.10, 7.4 | 2 |
| `users` | id, email, display\_name, password\_hash, google\_sub, created\_at | 6.1 | 4 |
| `board_members` | board\_id, user\_id, role | 6.3 | 4 |
| `share_links` | id, board\_id, token, role, created\_by, expires\_at, revoked\_at | 6.4 | 4 |
| `snapshots` | id, board\_id, seq, data (jsonb), label, created\_at | 6.5, 6.6 | 4 |
| `comments` | id, board\_id, parent\_id, element\_id, x, y, author\_id, body, resolved\_at, created\_at | 5.1 | 5 |
| `notifications` | id, user\_id, comment\_id, read\_at, created\_at | 5.2 | 5 |
| `templates` | id, name, data (jsonb) | 5.9 | 5 |

Con trỏ, ai đang online, ai đang chọn gì **không có bảng**. Đó là dữ liệu tạm, giữ trong bộ nhớ server (hoặc Redis khi chạy nhiều server).

### 4.2 Bảng `elements`: một mô hình cho mọi thứ

Mọi đối tượng trên bảng nằm chung một bảng. Các trường giống nhau (vị trí, thứ tự lớp, ai sửa) là cột thật. Các trường khác nhau theo loại (điểm của nét vẽ, chữ trong sticky) nằm trong cột `data` kiểu JSON.

Lý do dùng JSON: server không cần tìm kiếm bên trong hình vẽ, chỉ cần lưu và trả lại. Nếu mỗi loại hình một bảng, bạn sẽ có 10 bảng và mỗi tính năng mới phải sửa database.

```prisma
model Element {
  boardId   String   @map("board_id") @db.Uuid
  id        String                                       // client tự sinh (UUID), để vẽ ngay không chờ server
  type      String                                       // "freedraw", "rect", "ellipse", "diamond", "line", "arrow", "text", "sticky", "image", "frame", "stamp"
  data      Json                                         // các trường riêng theo loại
  zIndex    String   @map("z_index")                     // thứ tự lớp, xem 4.4
  version   Int      @default(0)                         // tăng mỗi lần sửa
  isDeleted Boolean  @default(false) @map("is_deleted")  // xóa mềm
  locked    Boolean  @default(false)                     // 2.12
  groupId   String?  @map("group_id")                    // 2.6
  frameId   String?  @map("frame_id")                    // 5.7
  updatedBy String   @map("updated_by")
  updatedAt DateTime @updatedAt @map("updated_at")
  board     Board    @relation(fields: [boardId], references: [id])

  @@id([boardId, id])
  @@map("elements")
}
```

Ví dụ cột `data` của từng loại:

| Type | Nội dung `data` |
| --- | --- |
| freedraw | x, y, points (mảng \[x, y\] tương đối với x, y), strokeColor, strokeWidth, opacity |
| rect / ellipse / diamond | x, y, width, height, angle, strokeColor, fillColor, strokeWidth, strokeStyle (solid/dashed), opacity |
| line / arrow | x, y, points, startBinding { elementId }, endBinding { elementId }, arrowhead |
| text | x, y, width, text, fontSize, color, align |
| sticky | x, y, width, height, text, color |
| image | x, y, width, height, angle, assetId |
| frame | x, y, width, height, name |

**Khóa chính** là (board\_id, id). Id do client sinh nên chỉ cần duy nhất trong một bảng.

**Xóa mềm** (`is_deleted = true`) thay vì xóa thật: undo được, khôi phục phiên bản được, và người rớt mạng vẫn biết là element đó đã bị xóa.

### 4.3 Bảng `operations`: nhật ký thao tác

Mỗi thao tác hợp lệ được ghi một dòng, đánh số `seq` tăng dần theo từng bảng. `boards.last_seq` giữ số mới nhất.

```prisma
model Operation {
  boardId   String   @map("board_id") @db.Uuid
  seq       Int                                  // server cấp: 1, 2, 3... (Int thay vì BigInt vì BigInt không JSON.stringify được)
  opId      String   @map("op_id") @db.Uuid      // client sinh, dùng để chống gửi trùng
  type      String                               // "add", "update", "delete", "reorder", "clear"
  elementId String?  @map("element_id")
  payload   Json
  actor     String
  createdAt DateTime @default(now()) @map("created_at")

  @@id([boardId, seq])
  @@unique([boardId, opId])
  @@map("operations")
}
```

Nhật ký này dùng cho ba việc: người rớt mạng xin lại các op bị lỡ (4.8), xem lịch sử (6.5), và kiểm tra lỗi khi có bug. Nó không phải nguồn để tải bảng. Tải bảng thì đọc thẳng từ `elements`, nhanh hơn nhiều.

Hai bảng `elements` và `operations` được ghi **trong cùng một transaction** (giao dịch: hoặc cả hai cùng thành công, hoặc cả hai cùng hủy), với Prisma là `prisma.$transaction(async (tx) => { ... })`. Như vậy chúng không bao giờ lệch nhau.

### 4.4 Thứ tự lớp (z\_index)

Nếu dùng số nguyên 1, 2, 3, muốn chèn một hình vào giữa lớp 1 và 2 thì phải đánh số lại cả bảng. Cách đơn giản nhất để tránh việc đó: dùng số thực, chèn giữa a và b thì lấy (a + b) / 2. Khi làm kỹ hơn thì chuyển sang "fractional indexing" (dùng chuỗi như "a0", "a0V", "a1" để chèn giữa vô hạn lần).

### 4.5 Index cần có

- `elements (board_id) WHERE is_deleted = false`: tải bảng khi vào phòng.
- `operations (board_id, seq)`: khóa chính, lấy các op sau một số seq.
- `operations (board_id, op_id)` UNIQUE: chống ghi trùng khi client gửi lại.
- `board_members (user_id)`: trang "bảng của tôi".
- `share_links (token)` UNIQUE: tra link chia sẻ.
- `comments (board_id)`, `notifications (user_id, read_at)`.

Index có điều kiện `WHERE` (index đầu tiên) nếu bản Prisma đang dùng chưa khai báo được trong `schema.prisma` thì viết bằng SQL: chạy `prisma migrate dev --create-only` rồi thêm câu `CREATE INDEX ... WHERE is_deleted = false` vào file migration.

## 5. Giao thức sự kiện

Mọi thay đổi lâu dài đi qua **một sự kiện duy nhất**: `SubmitOps`. Mọi thứ tạm thời (con trỏ, laser, emote) đi qua các sự kiện riêng và không bao giờ lưu. Chia như vậy thì logic lưu trữ chỉ phải viết ở một chỗ.

### 5.1 Định dạng một operation

```json
{
  "opId": "7f3c...",
  "type": "update",
  "elementId": "el_91a",
  "baseVersion": 4,
  "patch": { "x": 320, "y": 140 }
}
```

- `opId`: client tự sinh. Nếu gửi lại do rớt mạng, server thấy trùng thì bỏ qua.
- `baseVersion`: version của element mà client đang thấy lúc sửa. Server dùng để phát hiện xung đột (phần 7).
- `patch`: chỉ chứa **những trường thay đổi**. Người A kéo hình (x, y) và người B đổi màu cùng lúc thì cả hai đều được giữ.

Các loại op:

| type | Dữ liệu kèm theo | Dùng cho |
| --- | --- | --- |
| `add` | element đầy đủ (id, type, data) | vẽ nét, thêm hình, paste, nhân bản, import |
| `update` | elementId, baseVersion, patch | di chuyển, đổi kích thước, xoay, đổi style, sửa chữ, khóa, nhóm |
| `delete` | elementId | tẩy, xóa |
| `restore` | elementId, hoặc clearSeq (seq của op `clear` cần hoàn tác) | undo một lần xóa, undo xóa sạch bảng |
| `reorder` | elementId, position: front / back / forward / backward | thứ tự lớp (2.8) |
| `clear` | không có (phải là op duy nhất trong lô) | xóa sạch bảng, giữ lại element đang khóa (1.7) |

### 5.2 Client gửi server (sự kiện gateway nhận)

| Sự kiện | Tham số | Lưu DB? |
| --- | --- | --- |
| `JoinBoard` | boardId, displayName, lastSeq (nếu đang kết nối lại), shareToken | không |
| `SubmitOps` | danh sách op (gửi theo lô) | **có** |
| `UpdateCursor` | x, y (tọa độ bảng, không phải tọa độ màn hình) | không |
| `UpdateSelection` | danh sách elementId đang chọn, `editingElementId` nếu đang sửa một ô chữ (khóa mềm, 7.3) | không |
| `UpdateViewport` | x, y, zoom | không |
| `SendEphemeral` | kind (laser, emote, cursorChat, dragPreview), payload | không |
| `Ping` | clientTime | không |

### 5.3 Server gửi client

| Sự kiện | Gửi cho | Nội dung |
| --- | --- | --- |
| `BoardState` | người vừa vào | các element, last\_seq, danh sách người online, ai đang chọn gì |
| `OpsApplied` | cả phòng (kể cả người gửi) | các op đã được chấp nhận, mỗi op kèm seq và version mới |
| `OpRejected` | chỉ người gửi | opId, lý do, element hiện tại để client sửa lại hiển thị |
| `MissedOps` | người vừa kết nối lại | các op từ lastSeq trở đi |
| `UserJoined` / `UserLeft` | người khác trong phòng | thông tin người dùng, màu |
| `CursorMoved`, `SelectionChanged`, `ViewportChanged`, `Ephemeral` | người khác trong phòng | chuyển tiếp nguyên trạng |
| `BoardReset` | cả phòng | sau khi khôi phục phiên bản cũ, client tải lại toàn bộ |
| `AccessChanged` | người bị đổi vai trò / thu hồi quyền | lý do; server ngắt kết nối ngay sau đó (8.2) |
| `Pong` | người hỏi | serverTime, để đồng bộ đồng hồ (5.6) |

**Vì sao gửi `OpsApplied` cho cả người gửi?** Để người gửi biết op của mình đã được nhận, được số seq nào. Client nhận ra op của mình nhờ `opId`, nên không vẽ lại lần hai.

### 5.4 Luồng một thao tác đi từ đầu đến cuối

1. Người A kéo hình. Client A cập nhật màn hình **ngay lập tức** (không chờ server) và đưa op vào hàng đợi "chưa xác nhận".
2. Mỗi khoảng 50ms, client A gom các op trong hàng đợi gửi lên bằng `SubmitOps`.
3. Server kiểm tra: A có trong phòng không, có quyền sửa không, dữ liệu có hợp lệ không, element có bị khóa không. **Mỗi op được xét riêng:** op hỏng (element đã bị xóa, đang khóa…) bị trả `OpRejected`, các op khác trong cùng lô vẫn được lưu. Riêng lô sai định dạng (sai kiểu, quá 100 op) thì bị từ chối cả lô.
4. Server khóa bảng đó (chỉ một op của một bảng được xử lý tại một thời điểm), cấp seq, tăng version, ghi `elements` và `operations` trong một transaction.
5. Server gửi `OpsApplied` cho cả phòng.
6. Client A thấy opId của mình, xóa khỏi hàng đợi. Client B, C áp thay đổi lên màn hình.

## 6. Use case và luồng xử lý

Mỗi tính năng dưới đây được quy về: đi qua REST hay Socket.IO, dùng loại op nào, chạm vào bảng nào. Cấp 1 được viết đầy đủ từng bước vì mọi cấp sau xây trên nó.

### Cấp 1 — MVP

**UC 1.1 — Tạo bảng**

1. Client gọi `POST /api/v1/boards` (REST, không phải Socket.IO, vì đây là yêu cầu một lần, cần kết quả trả về).
2. Server sinh `boardId` (UUID, `crypto.randomUUID()`), tạo dòng `boards`, trả về `{ boardId }`.
3. Client chuyển sang `/b/{boardId}`. Link này chính là link chia sẻ.

**UC 1.4 + 1.5 — Vào phòng và danh sách online**

1. Client hỏi tên nếu chưa có, lưu vào localStorage cho lần sau. Client cũng sinh một `clientId` cố định lưu localStorage, để nhận ra cùng một người mở nhiều tab.
2. Client kết nối Socket.IO rồi gửi `JoinBoard(boardId, name)`.
3. Server kiểm tra bảng có tồn tại. Không có thì trả lỗi.
4. Server cho socket vào room `board:{boardId}` (`client.join(...)`), gán một màu, lưu vào bộ nhớ: `Map<boardId, Map<socketId, PresenceInfo>>`. Node.js chạy một luồng nên `Map` thường là đủ, không cần cấu trúc chống tranh chấp.
5. Server gửi `BoardState` cho người vừa vào và `UserJoined` cho những người khác.
6. Khi tab đóng hoặc rớt mạng, NestJS tự gọi `handleDisconnect` (gateway implement `OnGatewayDisconnect`), socket tự rời mọi room. Server xóa khỏi bộ nhớ và gửi `UserLeft`.

> Lưu ý: hai tab của cùng một người là hai connection. Danh sách online nên gom theo `clientId`, chỉ báo "rời phòng" khi tab cuối cùng đóng.

**UC 1.2 + 1.3 — Vẽ tự do và hiện trên máy người khác**

1. Nhấn chuột: client sinh id cho nét vẽ, bắt đầu ghi lại các điểm.
2. Nhả chuột: client gửi một op `add` với type `freedraw`, kèm màu, độ dày và mảng điểm.
3. Server xử lý như luồng ở 5.4 và gửi `OpsApplied` cho cả phòng.

Bản đơn giản nhất: người khác chỉ thấy nét vẽ **sau khi nhả chuột**. Muốn họ thấy nét vẽ dần dần trong lúc vẽ thì gửi thêm sự kiện tạm `SendEphemeral("strokeProgress", ...)` mỗi 50ms, không lưu. Làm bản đơn giản trước.

**UC 1.6 — F5 vẫn thấy nội dung cũ**

1. Mỗi lần vào phòng, `BoardState` trả về toàn bộ element chưa bị xóa, sắp theo `z_index`.
2. Bước đầu: giữ element trong một `Map` trên bộ nhớ server. Chạy được rồi mới chuyển sang bảng `elements` trong database. Khác biệt duy nhất là chỗ đọc và ghi.

**UC 1.7 — Xóa sạch bảng**

1. Client gửi op `clear`, một mình một lô.
2. Server đặt `is_deleted = true` cho mọi element **chưa xóa và không bị khóa** của bảng (element đang khóa, ví dụ ảnh nền, được giữ lại, đúng luật 2.12). Trong cùng transaction, server ghi một dòng vào `operations` với payload chứa **danh sách id vừa bị xóa**.
3. Server gửi `OpsApplied`. Mọi client xóa các element đó khỏi màn hình.

**Hoàn tác (Ctrl+Z):** client gửi `restore { clearSeq }` với seq của op `clear` (client biết số này từ `OpsApplied`). Server đọc danh sách id trong payload của op đó và khôi phục đúng những element ấy. Element người khác vẽ sau khi xóa không bị ảnh hưởng. Không bắt client gửi danh sách id, vì bảng có thể có tới 50.000 element, vượt giới hạn kích thước tin.

Nên hỏi xác nhận ở client trước khi gửi, vì thao tác này ảnh hưởng tất cả mọi người.

### Cấp 2 — Công cụ vẽ và chỉnh sửa

Cấp 2 gần như không cần thêm logic server mới. Mọi tính năng đều là `add`, `update`, `delete` trên bảng `elements`. Phần việc chính là thiết kế đúng các trường trong `data`.

| Mã | Cách xử lý | Op | Ghi chú cho server |
| --- | --- | --- | --- |
| 2.1 | Thêm element type rect, ellipse, diamond, line, arrow | add | Kiểm tra type nằm trong danh sách cho phép |
| 2.2 | Element type text. Gõ chữ thì gửi `update` với patch `{ text }`, chờ ngừng gõ 300ms mới gửi | add, update | Giới hạn độ dài chữ. Hai người cùng gõ một ô: xem phần 7 |
| 2.3 | Element type sticky, có `text` và `color` | add, update |  |
| 2.4 | Tẩy chạm vào nét nào thì xóa cả nét đó | delete | Xóa mềm |
| 2.5 | **Trong lúc kéo**: gửi sự kiện tạm `dragPreview` để người khác thấy hình đang di chuyển. **Khi thả chuột**: gửi một op `update` duy nhất | update | Không lưu từng bước kéo chuột, chỉ lưu vị trí cuối |
| 2.6 | Nhóm: gán cùng `group_id` cho nhiều element. Chọn nhiều là việc của client | update (nhiều op một lô) | Xét từng op (5.4): element nào vừa bị người khác xóa thì op của nó bị từ chối, các element còn lại vẫn được nhóm |
| 2.7 | Copy/paste/nhân bản: client tạo element mới với id mới | add | Không có gì đặc biệt |
| 2.8 | Client gửi `reorder` với position "front" | reorder | **Server tự tính** z\_index mới. Hai người cùng bấm "lên trên" sẽ không ra cùng một giá trị |
| 2.9 | Đổi viền, nền, nét đứt, độ trong suốt | update | Kiểm tra giá trị hợp lệ (opacity 0–1, màu đúng định dạng) |
| 2.10 | Xem luồng bên dưới | add | Ảnh **không** đi qua WebSocket |
| 2.11 | Mũi tên lưu `startBinding` / `endBinding` = id của hình | add, update | Xem ghi chú bên dưới |
| 2.12 | Cột `locked = true` | update | Server từ chối mọi update/delete lên element đang khóa, trừ op mở khóa |

**UC 2.10 — Chèn ảnh**

1. Client gửi file bằng `POST /api/v1/boards/{id}/assets` (REST, multipart).
2. Server nhận file bằng `FileInterceptor` của NestJS, kiểm tra bằng `ParseFilePipe` + `MaxFileSizeValidator` / `FileTypeValidator`: kích thước (ví dụ tối đa 10 MB) và loại file (chỉ png, jpeg, gif, webp), lưu file vào ổ đĩa (sau này là S3 hoặc MinIO), tạo dòng `assets`, trả về `assetId` và URL.
3. Client gửi op `add` với type `image` và `assetId`. Op chỉ chứa id, không chứa ảnh.

Lý do không gửi ảnh qua Socket.IO: tin nhắn có giới hạn kích thước (`maxHttpBufferSize`, mặc định 1 MB), và một ảnh vài MB sẽ làm nghẽn kênh vẽ của cả phòng.

**UC 2.11 — Mũi tên dính vào hình**

Cách đơn giản nhất: mũi tên chỉ lưu "tôi nối từ hình A đến hình B". Khi vẽ, client tự tính điểm đầu và cuối từ vị trí hiện tại của A và B. Hình di chuyển thì mũi tên tự đi theo, **không cần gửi thêm op nào**. Khi xóa hình A, client gửi kèm op bỏ `startBinding` của các mũi tên nối vào A.

### Cấp 3 — Canvas và điều hướng

Cấp 3 gần như hoàn toàn là việc của frontend. Backend chỉ cần tuân theo một quy tắc:

**Mọi tọa độ lưu trong database là tọa độ của bảng, không phải tọa độ màn hình.** Bảng có hệ tọa độ riêng, vô hạn. Mỗi người tự kéo và zoom màn hình của mình (gọi là viewport) mà không ảnh hưởng ai. Client chuyển đổi: tọa độ màn hình = (tọa độ bảng − vị trí viewport) × zoom.

| Mã | Ai làm | Ghi chú |
| --- | --- | --- |
| 3.1 | Client | Viewport (x, y, zoom) chỉ ở client, không lưu server |
| 3.2, 3.3 | Client | Bắt dính lưới và đường căn chỉnh tính lúc kéo chuột. Server chỉ nhận vị trí cuối |
| 3.4, 3.5 | Client | Tính từ danh sách element đã có |
| 3.6, 3.7 | Client | Có thể lưu tùy chọn dark mode vào bảng `users` nếu đã có tài khoản |
| 3.8 | Client | Dùng Pointer Events thay cho Mouse Events để chuột và cảm ứng chung một code |

### Cấp 4 — Cộng tác thời gian thực

Cấp 4 chia làm hai nhóm rất khác nhau. **Sự kiện tạm** (4.1–4.5, 4.10) dễ: server chỉ nhận rồi chuyển tiếp. **Đồng thời và mất mạng** (4.6–4.8) khó: được tách riêng ra phần 7.

**Nhóm sự kiện tạm — một khuôn chung cho tất cả:**

1. Client gửi (ví dụ `UpdateCursor(x, y)`), tối đa khoảng 20 lần mỗi giây.
2. Server kiểm tra connection có trong phòng, kiểm tra không gửi quá nhanh.
3. Server gửi bằng `client.to("board:{id}").emit(...)`: mọi người trong phòng **trừ người gửi**. (Gửi cho cả phòng kể cả người gửi, như `OpsApplied`, thì dùng `server.to("board:{id}").emit(...)`.)
4. Không ghi database. Mất một vài tin cũng không sao, tin sau sẽ đè lên.

| Mã | Sự kiện | Server làm gì thêm | Client làm gì |
| --- | --- | --- | --- |
| 4.1 | `UpdateCursor` | Không | Vẽ con trỏ kèm tên và màu đã được gán lúc vào phòng |
| 4.2 | (dùng lại 4.1) | Không | Nội suy: thay vì nhảy tới vị trí mới, trượt dần tới đó trong khoảng 50–100ms |
| 4.3 | `UpdateSelection` | Lưu selection hiện tại vào presence trong bộ nhớ, để người vào sau biết ai đang chọn gì | Vẽ viền màu quanh element người khác đang chọn |
| 4.4 | `UpdateViewport` | Không | Người theo dõi đặt viewport của mình bằng viewport nhận được |
| 4.5 | `SendEphemeral("cursorChat")` | Giới hạn độ dài tin | Hiện tin cạnh con trỏ vài giây rồi ẩn |
| 4.9 | (không có sự kiện) | Không | Dùng các sự kiện có sẵn của `socket.io-client`: `socket.on("disconnect")`, `socket.io.on("reconnect_attempt")`, `socket.io.on("reconnect")` |
| 4.10 | `SendEphemeral("laser")` | Không | Vẽ vệt sáng, mờ dần sau khoảng 1 giây |

**4.6, 4.7, 4.8** — undo của riêng mình, hai người sửa cùng một đối tượng, tự kết nối lại và gửi bù: xem **phần 7**.

### Cấp 5 — Tương tác và họp nhóm

| Mã | Cách xử lý | Kênh | Bảng DB |
| --- | --- | --- | --- |
| 5.1 | Bình luận gắn vào `element_id` hoặc tọa độ (x, y). Trả lời = comment có `parent_id`. Đánh dấu đã xử lý = đặt `resolved_at` | REST để tạo/sửa, rồi phát qua Socket.IO | `comments` |
| 5.2 | Server tìm `@userId` trong nội dung, tạo dòng `notifications`, gửi tới người đó nếu đang online | REST + Socket.IO | `notifications` (cần tài khoản, cấp 6) |
| 5.3 | Emote bay | Sự kiện tạm | không |
| 5.4 | Stamp là element type `stamp`, nằm lại trên bảng | op add | `elements` |
| 5.6 | Xem luồng bên dưới | Socket.IO | `boards` hoặc bộ nhớ |
| 5.7 | Frame là element type `frame`. Element nằm trong frame có `frame_id`. Kéo frame thì client gửi một lô update cho frame và mọi element con | op add, update | `elements` |
| 5.8 | Người trình chiếu gửi id frame hiện tại. Người xem tự zoom vào frame đó. Giống chế độ theo dõi 4.4 | Sự kiện tạm | không |
| 5.9 | Template lưu dạng JSON danh sách element. Tạo bảng từ template = sao chép element với id mới | REST | `templates` |

**Gửi bình luận từ REST ra Socket.IO như thế nào?** `CommentService` nhận `SocketEmitter` qua dependency injection (cơ chế NestJS tự đưa đối tượng cần dùng vào constructor). Lưu comment xong thì gọi `emitter.toBoard(boardId, "CommentAdded", comment)` để báo cả phòng. `SocketEmitter` nằm ở `infra/socket/` và không phụ thuộc module nào. `BoardGateway` gán `Server` cho nó lúc khởi động. Nhờ vậy service nào gọi nó cũng không tạo vòng phụ thuộc.

```ts
@Injectable()
export class SocketEmitter {
  private server?: Server;

  bind(server: Server) { this.server = server; }  // BoardGateway gọi trong afterInit(server)

  toBoard(boardId: string, event: string, data: unknown) {
    this.server?.to(`board:${boardId}`).emit(event, data);
  }

  kickFromBoard(room: string, reason: string) {   // 8.2: room = member:{boardId}:{userId} hoặc share:{linkId}
    this.server?.to(room).emit('AccessChanged', { reason }); // gửi trước để client biết vì sao bị ngắt
    this.server?.in(room).disconnectSockets();
  }
}
```

**UC 5.6 — Đồng hồ đếm ngược chung**

Cái bẫy: nếu server gửi "còn 59 giây, còn 58 giây..." mỗi giây, các máy sẽ lệch nhau do độ trễ mạng. Cách đúng:

1. Server lưu **thời điểm kết thúc** theo giờ UTC (ví dụ 10:35:00), rồi gửi thời điểm đó cho cả phòng một lần.
2. Mỗi client tự đếm: còn lại = thời điểm kết thúc − giờ hiện tại.
3. Đồng hồ máy người dùng có thể sai vài giây. Khi vào phòng, client gọi `Ping` để biết giờ server, tính độ lệch, rồi cộng độ lệch đó khi đếm.

### Cấp 6 — Tài khoản, phân quyền và lưu trữ

| Mã | Cách xử lý | Bảng DB |
| --- | --- | --- |
| 6.1 | `@nestjs/passport` + `@nestjs/jwt`: tự làm đăng ký/đăng nhập (băm mật khẩu bằng argon2 hoặc bcrypt) trả về JWT (một chuỗi token chứng minh bạn là ai, gửi kèm mỗi request). Google: dùng strategy `passport-google-oauth20` | `users` |
| 6.2 | REST: `GET /api/v1/boards?search=`, `PATCH /api/v1/boards/{id}` (đổi tên), `DELETE` (đặt `deleted_at`, không xóa thật) | `boards`, `board_members` |
| 6.3 | Xem **phần 8** | `board_members` |
| 6.4 | Link chia sẻ = token ngẫu nhiên gắn với một vai trò. Vào phòng bằng `?token=...`. Thu hồi = đặt `revoked_at` và ngắt kết nối những ai đã vào bằng token đó | `share_links` |
| 6.5 | Xem luồng bên dưới | `snapshots`, `operations` |
| 6.6 | Xem luồng bên dưới | `snapshots` |

**UC 6.6 — Tự lưu định kỳ**

Với thiết kế này, mỗi op đã được ghi thẳng vào `elements` nên **dữ liệu không bao giờ mất**, không cần "nút lưu". Snapshot ở đây phục vụ lịch sử:

1. Một job chạy nền dùng `@nestjs/schedule` (method gắn `@Interval(5 * 60_000)` hoặc `@Cron('*/5 * * * *')`) chạy mỗi 5 phút.
2. Với mỗi bảng có thay đổi kể từ snapshot gần nhất: chụp toàn bộ element hiện tại thành JSON, lưu vào `snapshots` kèm `seq` lúc chụp.
3. Các dòng `operations` cũ hơn snapshot gần nhất có thể xóa bớt sau một thời gian (ví dụ 30 ngày) để database không phình to.

**UC 6.5 — Xem và khôi phục phiên bản cũ**

1. `GET /api/v1/boards/{id}/snapshots` trả danh sách thời điểm.
2. Xem một bản: trả JSON của snapshot đó, client vẽ ở chế độ chỉ đọc.
3. Khôi phục: server thay toàn bộ `elements` bằng nội dung snapshot trong một transaction, ghi một op `restore_snapshot` vào nhật ký, rồi gửi `BoardReset` cho cả phòng. Mọi client tải lại bảng.

Trước khi khôi phục, server tự chụp một snapshot của trạng thái hiện tại. Như vậy lỡ khôi phục nhầm thì vẫn quay lại được.

### Cấp 7 — Xuất và nhập

| Mã | Ai làm | Cách xử lý |
| --- | --- | --- |
| 7.1 | Client | Vẽ canvas ra ảnh PNG, hoặc dựng SVG từ danh sách element |
| 7.2 | Server | Xuất: `GET /api/v1/boards/{id}/export` trả `{ formatVersion: 1, elements: [...] }`. Nhập: `POST`, server kiểm tra từng element như op thường, gán id mới, tạo op `add` |
| 7.3 | Client | Thư viện tạo PDF phía trình duyệt. Có thể làm phía server bằng `pdfkit` hoặc Puppeteer, nhưng không cần |
| 7.4 | Client | Dán chữ thành element text. Dán ảnh thì đi đúng luồng upload của 2.10 |

`formatVersion` quan trọng: sau này bạn đổi cấu trúc element thì file cũ vẫn đọc được, vì server biết nó thuộc phiên bản nào.

### Cấp 8 — Kỹ thuật nâng cao

| Mã | Hướng giải quyết | Mức khó |
| --- | --- | --- |
| 8.1 | Client gom op mỗi 50ms thành một lần gửi. Con trỏ tối đa 20 lần/giây. Server giới hạn số tin mỗi giây cho mỗi connection | Dễ |
| 8.2 | Client rút gọn điểm của nét vẽ trước khi gửi bằng thuật toán Ramer–Douglas–Peucker (bỏ những điểm gần như nằm trên một đường thẳng). Server giới hạn tối đa số điểm mỗi nét. Việc này cũng giúp nét dài không vượt giới hạn kích thước tin của Socket.IO (`maxHttpBufferSize`) | Dễ |
| 8.3 | Xem **phần 8** | Trung bình |
| 8.4 | Xem luồng bên dưới | Khó |
| 8.5 | Client chỉ vẽ element nằm trong viewport. Server không liên quan | Trung bình (frontend) |
| 8.6 | Mâu thuẫn với nhiều tính năng khác, xem **phần 10** | Khó |
| 8.7 | Client lưu element và hàng đợi op vào IndexedDB (database trong trình duyệt). Có mạng thì gửi. Mất mạng lâu và nhiều người cùng sửa sẽ dẫn tới bài toán CRDT | Rất khó |
| 8.8 | Viết một script Node.js dùng `socket.io-client` (hoặc Artillery, có sẵn engine Socket.IO), mở hàng trăm kết nối giả, mỗi kết nối vẽ ngẫu nhiên. Đo độ trễ từ lúc gửi tới lúc người khác nhận | Trung bình |

**UC 8.4 — Chạy nhiều server**

Khi có 2 server, người A kết nối server 1, người B kết nối server 2. Server 1 gửi cho room nhưng không biết B tồn tại. Có hai việc phải giải quyết:

1. **Phát tin giữa các server:** Socket.IO có sẵn Redis adapter (`@socket.io/redis-adapter`). Trong NestJS, viết một class kế thừa `IoAdapter` gắn adapter này rồi gọi `app.useWebSocketAdapter(...)` trong `main.ts`. Mỗi tin gửi cho room được chuyển qua Redis tới mọi server. Phần này gần như chỉ là cấu hình. Lưu ý: nếu còn bật long-polling, load balancer phải có **sticky session** (một client luôn về cùng một server); hoặc ép client chỉ dùng `transports: ["websocket"]`.
2. **Dữ liệu đang giữ trong bộ nhớ sẽ sai:** danh sách online, khóa xử lý theo bảng, bộ đếm seq. Mỗi server chỉ thấy phần của mình. Phải chuyển presence sang Redis, cấp seq bằng database hoặc lệnh `INCR` của Redis. Phần này mới là phần khó.

Cách tránh bớt việc thứ hai: định tuyến mọi người của cùng một bảng về cùng một server (ví dụ theo boardId). Khi đó khóa và seq vẫn ở bộ nhớ được.

## 7. Xử lý đồng thời và xung đột

Hướng chọn: **server xử lý tuần tự từng bảng + LWW theo từng trường**. Đơn giản, dễ hiểu, đúng trong hầu hết tình huống của một bảng vẽ. CRDT chỉ cân nhắc ở cuối.

### 7.1 Xử lý tuần tự trong một bảng

Node.js chạy một luồng, nhưng mỗi `await` (ví dụ chờ database) là một chỗ để tin khác chen vào. Nếu hai op của cùng một bảng xen kẽ nhau, cả hai có thể đọc `last_seq = 10` và cùng ghi seq 11. Giải pháp đơn giản nhất: mỗi bảng có một hàng đợi, mỗi lúc chỉ một op của bảng đó được xử lý. Các bảng khác nhau vẫn chạy song song.

```ts
@Injectable()
export class BoardLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(boardId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(boardId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work); // chờ tới lượt; op trước lỗi cũng không chặn op sau
    this.tails.set(boardId, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(boardId) === next) this.tails.delete(boardId); // không còn ai xếp hàng thì dọn
    }
  }
}
```

Mỗi bảng giữ một chuỗi Promise: op mới nối vào đuôi chuỗi và chỉ chạy khi op trước xong. Không muốn tự viết thì dùng thư viện `async-mutex`. `BoardLocks` là provider singleton mặc định nên mọi socket dùng chung. Cách này chỉ đúng khi chạy **một process**; chạy nhiều process (PM2 cluster, nhiều server) thì xem UC 8.4.

### 7.2 Luật xung đột (LWW theo từng trường)

Khi server nhận op `update`:

| Tình huống | Server làm gì |
| --- | --- |
| `baseVersion` = version hiện tại | Không có xung đột. Áp patch, tăng version |
| `baseVersion` nhỏ hơn (có người sửa trước) nhưng sửa **khác trường** | Vẫn áp patch. A đổi vị trí, B đổi màu, cả hai được giữ |
| `baseVersion` nhỏ hơn và sửa **cùng trường** | Vẫn áp patch: op đến sau thắng (LWW). Người kia thấy hình nhảy về giá trị mới |
| Element đã bị xóa | Từ chối, gửi `OpRejected`. Client bỏ thay đổi đó |
| Element đang khóa (2.12) | Từ chối, gửi `OpRejected` |
| Người gửi không có quyền sửa | Từ chối, gửi `OpRejected` |

Vì patch chỉ chứa trường thay đổi, xung đột thật chỉ xảy ra khi hai người sửa **đúng cùng một thuộc tính** của **đúng cùng một hình** trong cùng một khoảnh khắc. Với bảng vẽ, việc này hiếm.

### 7.3 Ngoại lệ: hai người cùng gõ một ô chữ

LWW với chữ rất tệ: A gõ "Xin chào", B gõ "Hello", một trong hai mất sạch. Cách thực tế nhất: **khóa mềm khi đang sửa chữ**. Người A bấm vào ô chữ thì client gửi `UpdateSelection` kèm `editingElementId`, server ghi nhận "A đang sửa" trong presence và từ chối op `update` sửa `text` của ô đó từ người khác. Người khác thấy viền màu kèm tên A và không vào chế độ sửa được. A thoát ra thì khóa tự mở; A rớt mạng thì khóa mở khi `handleDisconnect` chạy.

Cách "xịn" là CRDT cho văn bản (thư viện Yjs). Đây là chỗ Node.js có lợi: Yjs chạy được ngay trên server (có sẵn `y-websocket`, Hocuspocus), server hợp nhất và lưu được chứ không chỉ chuyển tiếp dữ liệu nhị phân. Dù vậy, không nên làm trong dự án này trừ khi bạn muốn đào sâu riêng chủ đề đó.

### 7.4 Undo/redo chỉ hoàn tác thao tác của mình (4.6)

Undo **không phải** "quay bảng về trạng thái trước", vì làm vậy sẽ xóa luôn việc người khác vừa làm. Undo là **gửi một op mới làm ngược lại op của mình**.

1. Mỗi lần gửi op, client lưu op ngược lại vào ngăn xếp undo (chỉ ở client, mất khi F5 là chấp nhận được):
   - `add` → ngược lại là `delete`
   - `delete` → ngược lại là `restore`
   - `clear` → ngược lại là `restore { clearSeq }` (xem UC 1.7)
   - `update` patch `{ x: 300 }` → ngược lại là `update` patch `{ x: giá trị cũ }`
2. Bấm Ctrl+Z: lấy op ngược ra khỏi ngăn xếp, gửi như op bình thường, đẩy vào ngăn xếp redo.
3. Nếu element đã bị người khác xóa, server từ chối. Client bỏ qua, chuyển sang mục undo kế tiếp.

Trường hợp khó: bạn di chuyển hình, sau đó người khác cũng di chuyển nó. Bạn bấm undo thì hình nhảy về chỗ cũ của bạn, đè lên việc của họ. Cách đơn giản: chấp nhận điều đó (Excalidraw cũng gần như vậy). Cách kỹ hơn: so version, nếu element đã bị người khác sửa sau mình thì bỏ qua lượt undo đó.

### 7.5 Mất mạng và kết nối lại (4.8)

1. `socket.io-client` mặc định tự thử kết nối lại (`reconnection: true`), không cần cấu hình thêm.
2. Trong lúc mất mạng, người dùng vẫn vẽ. Op nằm trong hàng đợi "chưa xác nhận" (đã có từ 5.4).
3. Kết nối lại xong, client gọi `JoinBoard(boardId, name, lastSeq)`, với `lastSeq` là seq lớn nhất nó đã nhận.
4. Server đọc `operations` có seq > lastSeq và trả `MissedOps`. Nếu số op lỡ quá nhiều (ví dụ hơn 1000), trả luôn `BoardState` đầy đủ cho nhanh.
5. Client áp các op bị lỡ, rồi gửi lại toàn bộ hàng đợi.
6. Server thấy `opId` đã tồn tại (nhờ unique index) thì bỏ qua op đó. Nhờ vậy gửi lại bao nhiêu lần cũng không bị trùng.

Bước 6 có tên là **idempotent**: làm một lần hay nhiều lần thì kết quả như nhau. Đây là tính chất quan trọng nhất của mọi hệ thống có gửi lại.

## 8. Phân quyền và bảo mật

Quy tắc gốc: **không bao giờ tin client**. Mọi kiểm tra quyền và dữ liệu đều làm ở server, kể cả khi giao diện đã ẩn nút đi.

### 8.1 Bảng quyền theo vai trò

| Hành động | Chủ sở hữu | Người sửa | Người bình luận | Người xem |
| --- | --- | --- | --- | --- |
| Xem bảng, thấy con trỏ người khác | có | có | có | có |
| Gửi con trỏ, viewport, emote, laser | có | có | có | không |
| Bình luận | có | có | có | không |
| `SubmitOps` (vẽ, sửa, xóa) | có | có | không | không |
| Xóa sạch bảng, khôi phục phiên bản | có | có | không | không |
| Khóa / mở khóa element | có | có | không | không |
| Mời người, đổi vai trò, tạo/thu hồi link | có | không | không | không |
| Đổi tên, xóa bảng | có | không | không | không |

Giai đoạn chưa có tài khoản: ai có link cũng là người sửa.

### 8.2 Kiểm tra quyền trên Socket.IO

REST kiểm tra quyền ở mỗi request, quen thuộc. Socket.IO khác: kết nối mở một lần rồi gửi hàng nghìn tin. Không nên truy vấn database ở mỗi nét vẽ.

1. **Khi `JoinBoard`:** xác định vai trò (từ `board_members` theo user, hoặc từ `share_links` theo token). Lưu vào `client.data.boardId` và `client.data.role`. `socket.data` là chỗ chứa dữ liệu riêng của từng socket, sống tới khi socket đóng.
2. **Mỗi sự kiện khác:** đọc lại từ `client.data`. Kiểm tra socket đã vào đúng bảng đó chưa (không tin `boardId` client gửi lên) và vai trò có đủ quyền không.
3. **Khi chủ sở hữu đổi vai trò hoặc thu hồi link:** server phải tìm các socket đang mở của người đó **trên đúng bảng đó** để ngắt.
   - Lúc `JoinBoard`, cho socket vào thêm room `member:{boardId}:{userId}` (hoặc `share:{linkId}` nếu vào bằng link). Không dùng room `user:{userId}` để ngắt, vì như vậy sẽ đá người đó khỏi **mọi** bảng.
   - Server gửi `AccessChanged` (kèm lý do) cho room đó **trước**, rồi mới gọi `disconnectSockets()`.
   - Client **không** tự kết nối lại khi chính server ngắt (Socket.IO chỉ tự kết nối lại khi rớt mạng). Nhận `AccessChanged` thì client hiện thông báo, rồi tự gọi `socket.connect()` và `JoinBoard` lại để nhận vai trò mới, hoặc quay về trang chủ nếu đã mất quyền.
   - Không cần tự giữ map userId → socket.

**Xác thực WebSocket:** trình duyệt không cho gắn header `Authorization` vào WebSocket. Socket.IO giải quyết bằng trường `auth` lúc bắt tay: client gọi `io(url, { auth: { token } })`, server đọc `socket.handshake.auth.token` và kiểm tra JWT trong middleware `server.use(...)` (đăng ký trong `afterInit` của gateway), sai thì từ chối kết nối. Guard của NestJS chỉ chạy theo từng tin, không chạy lúc kết nối, nên đừng chỉ dựa vào guard.

### 8.3 Kiểm tra dữ liệu và chống spam

| Kiểm tra | Ví dụ giới hạn |
| --- | --- |
| Kích thước một tin Socket.IO | `maxHttpBufferSize`, mặc định 1 MB; nên hạ xuống, ví dụ 100 KB |
| Số op trong một lô | tối đa 100 |
| Type của element | chỉ trong danh sách cho phép |
| Số điểm của một nét vẽ | tối đa 5.000 |
| Độ dài chữ, tên, bình luận | chữ 10.000 ký tự, tên 50 |
| Tọa độ, kích thước | là số hữu hạn, không phải NaN hay vô cực |
| Tốc độ gửi mỗi connection | ví dụ 30 lần `SubmitOps` mỗi giây, 30 lần con trỏ mỗi giây |
| File upload | 10 MB, chỉ loại ảnh cho phép |
| Số element mỗi bảng | ví dụ 50.000, để một người không làm phình database |

Các con số trên là điểm khởi đầu hợp lý, không phải tiêu chuẩn. Đo thực tế rồi chỉnh.

Kiểm tra dữ liệu dùng schema Zod (`@Body({ schema })`, `@MessageBody({ schema })`) với `StandardSchemaValidationPipe` có sẵn của NestJS 12. Lỗi trong gateway phải tới client dưới dạng `WsException` thay vì `HttpException`.

Khi vượt giới hạn tốc độ: lần đầu bỏ qua tin, nhiều lần thì ngắt kết nối. Dùng thuật toán "token bucket": mỗi connection có một xô chứa tối đa N lượt, mỗi giây được thêm lượt mới, gửi tin thì trừ một lượt, hết lượt thì từ chối.

## 9. Lộ trình triển khai

Làm theo giai đoạn, mỗi giai đoạn có một bài kiểm tra "xong khi" rõ ràng. Chưa qua bài kiểm tra thì chưa sang giai đoạn sau.

&#91;embedded content: lộ trình · 5 giai đoạn, 4 cổng kiểm tra\]

Hết giai đoạn 4 là đã có một dự án đủ để đưa vào CV và kể khi phỏng vấn: realtime, xử lý đồng thời, mất mạng, phân quyền trên WebSocket. Các cấp 3, 5, 7 phần lớn là việc frontend nên để sau nếu mục tiêu là học NestJS.

## 10. Rủi ro, mâu thuẫn và câu hỏi còn mở

### 10.1 Mâu thuẫn trong danh sách tính năng

**8.6 (mã hóa đầu-cuối) mâu thuẫn với nhiều tính năng.** Mã hóa đầu-cuối kiểu Excalidraw: khóa giải mã nằm sau dấu `#` của link, trình duyệt không bao giờ gửi phần đó lên server. Server chỉ thấy dữ liệu đã mã hóa. Hệ quả:

- Không kiểm tra được dữ liệu (8.3): server không biết bên trong là gì.
- Không áp patch theo trường (phần 7): server không đọc được trường nào.
- Không tạo snapshot và lịch sử phiên bản có nghĩa (6.5), không xuất JSON phía server (7.2), không phân tích @mention (5.2).

Kết luận: chọn một trong hai hướng. Gợi ý: **bỏ 8.6** cho dự án này. Nếu muốn thử, làm thành một chế độ "phòng riêng tư" tách hẳn, trong đó server chỉ chuyển tiếp mà không lưu.

**Danh sách nhảy từ 5.4 sang 5.6**, không có 5.5.

### 10.2 Rủi ro kỹ thuật

| Rủi ro | Vì sao | Cách giảm |
| --- | --- | --- |
| Khối lượng frontend lớn | Canvas, chọn, kéo, xoay, đổi kích thước, cảm ứng là nhiều tuần làm JavaScript | Dùng thư viện vẽ có sẵn (Konva.js) hoặc giới hạn Cấp 2 ở vài loại hình |
| Bảng có nhiều nét vẽ thì tải chậm | Mỗi nét vẽ có hàng trăm điểm, bảng lớn có thể vài MB | Rút gọn điểm (8.2). Sau này có thể nén khi trả `BoardState` |
| Bảng `operations` phình to | Mỗi op một dòng, không bao giờ xóa | Dọn op cũ hơn snapshot sau 30 ngày (6.6) |
| Dữ liệu trong bộ nhớ mất khi server khởi động lại | Presence, khóa, selection | Chấp nhận được: client tự kết nối lại và gửi lại presence. Dữ liệu thật đã nằm trong DB |
| Chạy nhiều server làm sai dữ liệu bộ nhớ | Xem UC 8.4 | Chỉ làm khi thật sự muốn học phần này |
| Undo đè việc người khác | Xem 7.4 | Chấp nhận ở bản đầu |
| CRDT tốn nhiều thời gian | Chủ đề nghiên cứu riêng | Dùng LWW + khóa mềm khi sửa chữ |

### 10.3 Câu hỏi cần bạn quyết định

- [ ] Frontend dùng gì: JavaScript thuần với canvas, React, hay thư viện vẽ có sẵn?
- [ ] Database: PostgreSQL ngay từ đầu, hay SQLite trước rồi chuyển?
- [ ] ORM: Prisma (tài liệu này đang giả định) hay TypeORM?
- [ ] Sau khi có tài khoản (cấp 6), khách chưa đăng nhập có còn được vẽ qua link không?
- [ ] Giữ hay bỏ 8.6?
- [ ] Nét vẽ hiện dần trong lúc vẽ (stream) hay chỉ hiện khi nhả chuột ở bản đầu?
