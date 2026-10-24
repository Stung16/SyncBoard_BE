# Hướng dẫn tự code backend SyncBoard: logic, API thư viện, bẫy

Ngày khảo sát: 2026-10-24. Tài liệu này dạy **cách tự viết** từng module: logic từng bước, dùng API nào của thư viện, và cái gì có thể hỏng. Nó không phải code hoàn chỉnh. Skeleton chỉ xuất hiện ở chỗ cách dùng thư viện dễ sai.

Không nói về cài đặt, config, docker, lint. Phần đó nằm ở `docs/research/setup-guide.md`. Ở đây giả định app đã được scaffold đúng cây thư mục trong `docs/research/nestjs-folder-structure.md` mục 4, và đã tuân theo quy tắc phụ thuộc ở mục 4–5 của file đó.

Ký hiệu `[Sx]` trỏ tới mục **Nguồn** ở cuối. Chỗ ghi "(chạy thử)" là đã chạy thật trên Node v24.18.0 trong lúc khảo sát. Mã mục như "7.2" hay "UC 2.10" trỏ tới tài liệu thiết kế `SyncBoard — Phân tích thiết kế.md`.

---

## 0. Phiên bản thư viện và một cảnh báo về Prisma

Phiên bản lấy từ npm registry ngày 2026-10-24 [S68]:

| Package | `latest` | Ghi chú |
|---|---|---|
| `@nestjs/core`, `@nestjs/websockets`, `@nestjs/platform-socket.io` | 12.2.0 | `@nestjs/common@12` là package ESM (`"type": "module"`) [S17] |
| `socket.io` / `socket.io-client` | 4.8.4 | |
| `@prisma/client` | 7.10.1 | |
| `prisma` (CLI) | **8.0.0-rc.27** | `latest` đang trỏ tới bản RC |
| `class-validator` / `class-transformer` | 0.15.1 / 0.5.1 | |
| `fractional-indexing` | 4.0.0 | chỉ có ESM, license CC0 |
| `@nestjs/schedule` | 12.0.2 | |
| `@nestjs/passport` / `@nestjs/jwt` / `passport-jwt` | 12.0.0 / 12.0.3 / 4.0.1 | |
| `passport-google-oauth20` | 2.0.0 | |
| `argon2` / `bcrypt` | 0.45.1 / 6.0.0 | argon2 có sẵn prebuild `win32-x64` [S66] |
| `@nestjs/throttler` | 6.7.1 | peer dependency hỗ trợ Nest 12 |
| `multer` | 2.5.0 | `@nestjs/platform-express@12.2.0` đang ghim multer 2.4.0 [S19] |
| `file-type` | 22.2.0 | `FileTypeValidator` của Nest dùng gói này [S17] |

**Cảnh báo Prisma:** docs hiện tại của Prisma viết cho Prisma ORM 8. Bản 8 **không còn `$transaction`**. Nó thay bằng `db.transaction(async (tx) => ...)`, không có option `timeout`, `maxWait` hay `isolationLevel`, và dùng mã lỗi kiểu mới [S39]. Tài liệu thiết kế, CLAUDE.md và docs NestJS đều viết theo Prisma 7. **Hướng dẫn này dùng API Prisma 7.10.x** (`prisma.$transaction`, `P2002`…) và trích từ docs bản v7 [S32–S38]. Hãy ghim `prisma@7.10.1` và `@prisma/client@7.10.1`, đừng cài tag `latest`. Báo cho agent viết setup-guide nếu họ chọn khác.

**Về auth:** docs NestJS v12 đã có package mới `@nestjs/authentication` [S15]. Trên npm nó mới ở bản 0.1.1, tạo ngày 2026-09-29 [S68]. Hướng dẫn này giữ `@nestjs/passport` + `@nestjs/jwt` như CLAUDE.md quy định, vì recipe passport vẫn còn trong docs [S14].

---

## 1. `board/domain/`: hàm thuần (GĐ1, mở rộng ở GĐ2)

Thư mục `src/modules/board/domain/` gồm `apply-op.ts`, `z-index.ts`, `permissions.ts`, và mỗi file một `*.spec.ts` đặt cạnh. Không import NestJS, Prisma hay Socket.IO. Đây là nơi chứa phần khó nhất, nên viết nó trước và test kỹ nhất.

### 1.1 `apply-op.ts`: LWW theo trường

**Mục tiêu:** cho trạng thái hiện tại của một element (hoặc `undefined`) cộng một op, trả về element mới, hoặc lý do từ chối. Hàm không đụng DB và không cấp `seq` (service làm việc đó).

**Kiểu dữ liệu nên tự định nghĩa** (TypeScript thuần):

```ts
type ElementState = {
  id: string; type: ElementType; data: Record<string, unknown>;
  zIndex: string; version: number; isDeleted: boolean; locked: boolean;
  groupId: string | null; frameId: string | null; updatedBy: string;
};
type ApplyResult =
  | { ok: true; next: ElementState; resolvedOp: ResolvedOp }   // resolvedOp = op sau khi server đã điền giá trị (zIndex...)
  | { ok: false; reason: RejectReason };
function applyOp(current: ElementState | undefined, op: Op, ctx: { actor: string; zIndexFor: ZIndexFn }): ApplyResult;
```

**Logic từng bước:**

1. `switch (op.type)`. Gặp type không biết thì trả `{ ok: false, reason: 'unknown_op' }`. DTO đã lọc rồi, nhưng domain không được giả định điều đó.
2. **`add`:**
   1. `current` đã tồn tại (kể cả đã xóa mềm) thì từ chối `already_exists`. Id do client sinh nên trùng là lỗi của client.
   2. `op.element.type` phải nằm trong allowlist `ELEMENT_TYPES` (UC 2.1).
   3. Gọi `validateData(type, data)` (bước 6). Không hợp lệ thì từ chối `invalid_data`.
   4. Server tự cấp `zIndex = ctx.zIndexFor('front')`. Không nhận zIndex từ client (xem 1.2).
   5. Trả element mới với `version = 1`, `isDeleted = false`, `locked = false`, `updatedBy = ctx.actor`.
3. **`update`:**
   1. `current` không có thì `not_found`. `current.isDeleted` thì `deleted` (7.2).
   2. `current.locked` và patch **không phải** op mở khóa thì `locked`. Định nghĩa op mở khóa là patch có đúng một khóa `{ locked: false }`. Nếu cho trộn `{ locked: false, x: 5 }` thì luật khóa có lỗ hổng.
   3. `op.baseVersion > current.version` thì `invalid_base_version`: client đang thấy một phiên bản không thể tồn tại. `baseVersion < version` **không** bị từ chối. Đó chính là LWW (bảng 7.2). Có thể trả kèm cờ `stale: true` để log hoặc để client làm undo "kỹ hơn" (7.4).
   4. Patch rỗng thì `empty_patch`.
   5. Tách patch thành hai phần:
      - **Cột meta:** `locked`, `groupId`, `frameId`.
      - **Trường data:** mọi khóa còn lại, nhưng chỉ khóa nằm trong allowlist của `current.type`.
      - Các khóa `id`, `type`, `version`, `isDeleted`, `zIndex`, `updatedBy` không bao giờ patch được. Gặp chúng thì `invalid_patch`.
   6. Validate giá trị từng khóa (bước 6).
   7. **Merge nông ở cấp một của `data`**: `nextData = { ...current.data, ...dataPatch }`. Lý do ở mục Bẫy bên dưới.
   8. `version = current.version + 1`, `updatedBy = ctx.actor`.
4. **`delete`:**
   - `not_found` hoặc `deleted` thì từ chối. `locked` thì từ chối.
   - Còn lại: `isDeleted = true`, `version + 1`. Giữ nguyên `data` để `restore` được.
5. **`restore`:**
   - `not_found` thì từ chối. Element chưa bị xóa thì `not_deleted`. Client undo thấy lý do này thì bỏ qua lượt (7.4).
   - Còn lại: `isDeleted = false`, `version + 1`.
6. **`reorder`:**
   - `not_found`, `deleted` hoặc `locked` thì từ chối.
   - `position ∈ {front, back, forward, backward}`. `zIndex` mới do `ctx.zIndexFor(position, current)` tính (1.2).
   - `resolvedOp` phải chứa **zIndex đã tính**, không chỉ chữ `"front"`. Bẫy 2 bên dưới giải thích vì sao.
7. **`clear`:** không đi qua `applyOp` từng element, vì một bảng có thể có tới 50.000 element. Domain chỉ cần một hàm `canClear(batch)`, và service chạy một câu `updateMany` (mục 2). Quy tắc đề xuất:
   - `clear` phải là op **duy nhất** trong lô của nó, nếu không thì từ chối cả lô.
   - `clear` bỏ qua element đang `locked`, cho nhất quán với luật 2.12 (đã chốt).
   - Payload của op `clear` lưu danh sách id vừa bị xóa (`deletedIds`). Undo là `restore { clearSeq }`: service đọc `deletedIds` từ dòng `operations` có seq đó, rồi `updateMany` các id vẫn còn `isDeleted = true` về `false` và tăng version (đã chốt, xem UC 1.7 của spec). Không nhận danh sách id từ client: 50.000 id vượt `maxHttpBufferSize`.
8. **`validateData(type, data)` / `validatePatchValue(type, key, value)`:** một bảng mô tả cho từng type, dùng chung cho `add`, `update` và import (7.2):
   - Số phải là `typeof v === 'number' && Number.isFinite(v)`.
   - `opacity` nằm trong [0, 1]. Màu khớp regex hex.
   - `points` là mảng các cặp số hữu hạn, tối đa 5.000 điểm.
   - `text` tối đa 10.000 ký tự. `strokeStyle ∈ {solid, dashed}`.
   - `startBinding` / `endBinding` là `null` hoặc `{ elementId: string }`.
   - `assetId` là UUID. Service còn phải kiểm tra asset đó thuộc đúng bảng (mục 5).
   - `null` trong patch nghĩa là "đặt thành null", ví dụ bỏ binding (UC 2.11). Không dùng `undefined`, vì JSON làm nó biến mất khỏi payload.

**Test nên viết** (`apply-op.spec.ts`, table-driven):

- Hai update khác trường trên cùng `baseVersion`: A `{x}` rồi B `{fillColor}`. Kết quả giữ cả hai, version tăng 2 lần.
- Hai update cùng trường: B, đến sau, thắng. Op của B có `baseVersion` cũ hơn vẫn được nhận.
- `baseVersion` lớn hơn version hiện tại thì bị từ chối.
- Update hoặc delete element đã xóa thì `deleted`. Restore element đã xóa thì OK. Restore element chưa xóa thì `not_deleted`.
- Element `locked`: update `{x}` bị từ chối, `{locked:false}` được nhận, `{locked:false, x:1}` bị từ chối, delete bị từ chối.
- `add` trùng id, kể cả trùng với element đã xóa mềm, thì `already_exists`.
- `add` có type `"script"` thì `invalid_data`.
- Patch `{ x: NaN }`, `{ x: Infinity }`, `{ x: null }` cho trường số, `{ x: "1" }` đều bị từ chối.
- Patch có khóa `__proto__`, `constructor`, `prototype` thì bị từ chối, và `({}).polluted === undefined` sau test.
- Patch `{ startBinding: null }` xóa binding. Patch `{ points: [...] }` thay **toàn bộ** mảng, không merge theo index.
- `points` 5.001 phần tử, `text` 10.001 ký tự thì bị từ chối.
- Hàm không mutate `current`: so `structuredClone` trước và sau.

**Bẫy có thể xảy ra:**

1. **Prototype pollution qua patch.**
   - `JSON.parse('{"__proto__":{"polluted":1}}')` tạo ra một own property tên `__proto__`, không đổi prototype [S61] (chạy thử).
   - Nếu sau đó bạn `Object.assign({}, patch)`, prototype của object đích **bị đổi** (chạy thử: `a.polluted === 1`), vì `Object.assign` dùng `[[Set]]` trên đích [S60].
   - Một hàm deep-merge tự viết kiểu `for (k in src) merge(t[k], src[k])` làm ô nhiễm **toàn cục**: sau đó `({}).polluted === 1` (chạy thử). Spread `{...patch}` thì giữ `__proto__` thành own property, không ô nhiễm, nhưng khóa đó vẫn bị lưu vào DB rồi phát cho mọi client.
   - **Cách tránh:** dùng allowlist khóa theo type. Khóa nào không có trong danh sách thì từ chối. OWASP khuyên thêm `Object.create(null)` hoặc `Map` cho dictionary [S59].
   - `class-transformer@0.5.1` tự bỏ qua khóa `__proto__` và `constructor` khi chuyển plain sang instance (đọc source [S48], chạy thử). Khóa `prototype` thì vẫn giữ. Payload có khóa `constructor` trỏ tới object còn làm `plainToInstance` ném `TypeError` (chạy thử), và client chỉ nhận "Internal server error".
   - Đừng dựa vào DTO. Domain còn được gọi từ đường import (7.2), nơi có thể không có DTO.
2. **`NaN` / `Infinity`.**
   - Qua Socket.IO, JSON biến `NaN` và `Infinity` thành `null` (chạy thử: `JSON.stringify({a:NaN})` ra `{"a":null}`). Vì vậy server thường thấy `null` ở chỗ cần số.
   - Với parser nhị phân, hoặc khi gọi domain từ code server, `NaN` lọt qua thật.
   - `isNumber` của class-validator mặc định từ chối `NaN` và `±Infinity`, trừ khi bật `allowNaN` / `allowInfinity` [S47]. Nhưng nó chỉ chạy trên field có decorator, còn `data` / `patch` là object tự do. Phải check `Number.isFinite` trong domain.
3. **Deep merge hay shallow merge.**
   - Merge sâu sai với dữ liệu bảng vẽ. Mảng `points` sẽ bị merge theo index, nét vẽ thành hỗn hợp của hai nét. `startBinding` sẽ trộn hai `elementId`.
   - Merge nông ở cấp một khớp đúng ý "LWW theo từng trường" (7.2). Đây cũng là cách Figma làm: last-writer-wins theo từng property, server quyết định thứ tự [S50].
   - Toán tử `jsonb ||` của PostgreSQL cũng chỉ merge cấp một ("Does not operate recursively") [S43]. Nếu sau này đẩy merge xuống SQL thì ngữ nghĩa vẫn giữ nguyên.
4. **Prisma `Json` không merge giúp bạn.** Docs Prisma chỉ có ví dụ "đọc object, sửa trong JS, ghi lại cả object" [S35]. Coi một lần `update({ data: { data: x } })` là **thay toàn bộ** cột. Vì vậy phải merge trong domain rồi ghi nguyên object.

### 1.2 `z-index.ts`: thứ tự lớp

**Lựa chọn: dùng thư viện `fractional-indexing@4.0.0`, không dùng số thực.**

| | Số thực `(a+b)/2` | `fractional-indexing` |
|---|---|---|
| Chèn giữa hai giá trị kề nhau | Chỉ được **52 lần** giữa 1 và 2 trước khi trung điểm bằng một đầu mút (chạy thử). Bấm "forward/backward" qua lại giữa hai hình là chạm giới hạn này | Không giới hạn. Khóa dài dần: 60 lần chèn vào cùng một khe vẫn chỉ ra khóa 12 ký tự (chạy thử) |
| Kiểu cột | Phải đổi `zIndex` sang `Float` | Đúng `String` như schema 4.2 đang khai báo |
| Nguồn | — | Figma dùng chỉ số phân số bằng chuỗi, "so that we can't run out of precision after lots of edits" [S49]. Thư viện dựa trên bài của David Greenspan [S51][S52] |

**API** [S51]:

- `generateKeyBetween(a: string | null | undefined, b: string | null | undefined): string`. `null` nghĩa là đầu hoặc cuối danh sách. `(null, null)` ra `"a0"`.
- `generateNKeysBetween(a, b, n): string[]`. Dùng khi paste hoặc import nhiều element cùng lúc: khóa đều hơn và ngắn hơn.
- Bản 4.0.0: nếu `a > b` thì **tự đổi chỗ**. Nếu `a === b` thì **ném lỗi**. Khóa sai định dạng ném `invalid order key` (đọc source và chạy thử).

**Logic từng bước** (`zIndexFor(position, current, neighbors)`):

1. `front`: `generateKeyBetween(maxZ, null)`. `back`: `generateKeyBetween(null, minZ)`.
2. `forward`: tìm element **chưa xóa** có zIndex lớn hơn `current` gần nhất (`n1`), và cái tiếp theo (`n2`). Kết quả là `generateKeyBetween(n1.z, n2?.z ?? null)`. Không có `n1` (đã ở trên cùng) thì trả "không đổi" và service coi là no-op. `backward` làm đối xứng.
3. `add`: luôn dùng `front`. Batch nhiều `add` thì gọi `generateNKeysBetween(maxZ, null, k)` một lần, rồi chia khóa theo thứ tự op.
4. Domain nhận `maxZ`, `minZ` và neighbors từ service. Domain không tự query.

**Test nên viết:**

- 1.000 lần `front` liên tiếp cho ra dãy tăng ngặt theo so sánh `<`.
- 100 lần chèn vào cùng một khe vẫn tăng ngặt.
- `forward` khi đã ở trên cùng là no-op.
- Neighbors đã bị xóa không được tính.
- Sort kết quả bằng `(a, b) => (a < b ? -1 : a > b ? 1 : 0)` khớp với thứ tự sinh ra.

**Bẫy có thể xảy ra:**

1. **Collation của PostgreSQL làm sai thứ tự.**
   - Khóa phân biệt hoa thường: `"Zz" < "a0"` theo byte. README cảnh báo đừng dùng `localeCompare` [S51].
   - Trên PostgreSQL, `ORDER BY z_index` dùng collation mặc định của database (`LC_COLLATE` lúc tạo DB). Chỉ collation `"C"` mới sort theo byte [S40]. Nếu DB tạo với `en_US.UTF-8`, `orderBy: { zIndex: 'asc' }` của Prisma có thể trả sai thứ tự.
   - **Cách tránh:**
     - Trong file migration (`--create-only`, như 4.5), viết `ALTER TABLE elements ALTER COLUMN z_index TYPE text COLLATE "C";`.
     - Hoặc sort trong JS khi trả `BoardState`.
     - Câu tìm `maxZ` / neighbors bằng raw SQL thì phải có `ORDER BY z_index COLLATE "C"` [S40].
   - SQLite mặc định so bằng `memcmp()` (BINARY) nên không gặp lỗi này [S44]. Chuyển từ SQLite sang Postgres là lúc bug lộ ra.
2. **Hai element trùng zIndex** thì `generateKeyBetween(a, a)` ném lỗi. Đừng bao giờ nhận zIndex từ client. Server cấp zIndex trong `BoardLocks` nên chỉ có một writer cho mỗi bảng. Đây cũng là cách Figma làm: server cấp vị trí duy nhất khi hai người chèn cùng chỗ [S49].
3. **ESM-only.** `fractional-indexing` khai báo `"type": "module"`. Nest 12 cũng là ESM [S17] nên `import` chạy bình thường. Test runner phải chạy được ESM: Nest có cảnh báo về Jest với `file-type` [S17]. Phần này thuộc setup-guide.

### 1.3 `permissions.ts`: bảng quyền 8.1

**Logic:**

1. `type Role = 'owner' | 'editor' | 'commenter' | 'viewer'`.
2. `type Action = 'view' | 'sendPresence' | 'comment' | 'submitOps' | 'clearOrRestoreVersion' | 'lockElement' | 'manageSharing' | 'renameOrDeleteBoard'`.
3. `const MATRIX: Record<Role, ReadonlySet<Action>>` chép đúng bảng 8.1. `can(role, action)` chỉ là tra bảng.
4. Gộp `UpdateCursor`, `UpdateSelection`, `UpdateViewport` và `SendEphemeral` vào `sendPresence`, vì viewer "không" gửi con trỏ, emote hay laser.
5. Op có patch chứa `locked` thì cần thêm `lockElement`. Op `clear` thì cần `clearOrRestoreVersion`. Hiện editor có cả hai quyền này nên kết quả như nhau, nhưng giữ riêng để sau đổi bảng dễ.
6. Trước GĐ4 (chưa có tài khoản), mọi người có link đều là `editor` (8.1).

**Test:** một test lặp đủ 4 × 8 ô, so với một bảng kỳ vọng chép tay từ spec. Bảng thay đổi thì test đỏ, nhắc bạn cập nhật tài liệu.

**Bẫy:**

- Kiểm tra quyền ở gateway bằng `if (role === 'editor')` rải rác khắp nơi thay vì gọi `can()`. Sau này thêm vai trò thì sót chỗ.
- Role phải đọc từ `client.data.role`, không đọc từ payload (8.2).

---

## 2. `BoardLocks` + `BoardService.submitOps` (GĐ1, log op ở GĐ3)

File: `board/board-locks.ts` (+ spec), `board/board.service.ts` (+ spec), `board/dto/op.dto.ts`, `board/dto/submit-ops.dto.ts`. Từ GĐ3 thêm `board/operation.service.ts`.

### 2.1 `BoardLocks`

Code mẫu ở 7.1 của tài liệu thiết kế đã đúng. Tự gõ lại và hiểu từng dòng. Thêm hai thứ:

- `size(): number`, chỉ dùng trong test, để kiểm tra Map được dọn.
- `drain(): Promise<void>`, chờ mọi `tails` xong. Dùng khi shutdown (mục 10.3).

**Test nên viết** (`board-locks.spec.ts`):

- Hai `run` cùng `boardId`. Việc thứ nhất `await` 20 ms. Ghi lại log `start1, end1, start2, end2` và kiểm tra không xen kẽ.
- Hai `boardId` khác nhau chạy song song: tổng thời gian nhỏ hơn tổng hai việc.
- Việc thứ nhất ném lỗi: việc thứ hai vẫn chạy, và `run` thứ nhất reject đúng lỗi đó.
- Xong hết thì `size() === 0`.
- 1.000 việc nối đuôi trên một bảng chạy đúng thứ tự.

### 2.2 DTO cho `SubmitOps`

**Thư viện:** `class-validator` + `class-transformer`, dùng discriminator.

- Bọc mảng trong một class: `class SubmitOpsDto { ops: OpDto[] }`. Lý do: "TypeScript does not emit metadata for generic types such as arrays" [S12], nên `@MessageBody() ops: OpDto[]` không được validate.
- `@ValidateNested({ each: true })` chỉ chạy khi phần tử là instance của class [S45]. Vì vậy cần `@Type` với discriminator [S46]:

```ts
class SubmitOpsDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true })
  @Type(() => BaseOpDto, {
    discriminator: { property: 'type', subTypes: [
      { value: AddOpDto, name: 'add' }, { value: UpdateOpDto, name: 'update' }, /* delete, restore, reorder, clear */
    ] },
    keepDiscriminatorProperty: true,   // mặc định thuộc tính discriminator bị xóa khi transform [S46]
  })
  ops!: BaseOpDto[];
}
```

Mỗi subtype khai báo đủ decorator:

- `@IsUUID() opId`, `@IsString() @MaxLength(64) elementId`.
- `@IsInt() @Min(0) baseVersion`, `@IsObject() patch`.
- `@IsIn([...]) position` cho reorder.

Ghi chú hai hành vi (chạy thử với class-validator 0.15.1 / class-transformer 0.5.1):

- `type: "bogus"` rơi về class `BaseOpDto`, không có metadata. Op đó bị từ chối **chỉ vì** `forbidUnknownValues` mặc định là `true` [S45]. Đừng tắt option này.
- `whitelist: true, forbidNonWhitelisted: true` từ chối khóa lạ ở cấp op, nhưng **không** nhìn vào bên trong `patch` (một object tự do). Bên trong `patch` là việc của domain.

### 2.3 `BoardService.submitOps`

**Chữ ký đề xuất:**

```ts
submitOps(boardId: string, actor: string, ops: OpDto[]):
  Promise<{ applied: AppliedOp[]; rejected: { opId: string; reason: string; current?: ElementState }[]; duplicates: { opId: string; seq: number }[] }>
```

`boardId` và `actor` luôn do gateway lấy từ `client.data`, không lấy từ payload.

**Ngữ nghĩa của một lô (đã chốt):**

- Lỗi DTO (sai kiểu, quá 100 op) thì **từ chối cả lô**, không ghi gì.
- Lỗi nghiệp vụ (element đã xóa hoặc bị khóa) thì **từ chối từng op**. Các op còn lại vẫn được áp.
- Lỗi DB thì **cả lô thất bại**: transaction rollback, không phát gì.
- Spec 2.6 đã được sửa theo cách này: khi nhóm 5 hình mà 1 hình vừa bị người khác xóa, 4 hình còn lại vẫn được nhóm. Không có cờ `atomic`.

**Logic từng bước** (tất cả nằm trong `boardLocks.run(boardId, async () => { ... })`):

1. Bỏ op trùng `opId` **ngay trong lô**, giữ cái đầu tiên.
2. *(GĐ3)* Chống gửi lại:
   - Chạy `prisma.operation.findMany({ where: { boardId, opId: { in: opIds } }, select: { opId: true, seq: true } })`.
   - Op đã có thì đưa vào `duplicates` (trả lại `seq` cũ cho client) và bỏ khỏi lô.
   - Câu này nằm trong lock nên không có race với chính process này.
3. Nạp mọi element mà lô chạm tới, bằng **một** query: `prisma.element.findMany({ where: { boardId, id: { in: elementIds } } })`. Dựng một `Map<id, ElementState>`.
4. Nếu lô có `reorder` hoặc `add`, nạp `maxZ`, `minZ` hoặc neighbors (raw SQL có `COLLATE "C"`, mục 1.2).
5. Nếu có `add`, kiểm tra trần 50.000 element mỗi bảng (8.3) bằng `count`, hoặc giữ bộ đếm trong bộ nhớ.
6. Lần lượt gọi `applyOp(map.get(id), op, ctx)`:
   - OK thì `map.set(id, next)`, để op sau trong cùng lô thấy kết quả của op trước.
   - Lỗi thì đẩy vào `rejected`, kèm `current` để client sửa lại màn hình (bảng 5.3).
7. Không còn op nào được nhận thì trả về luôn, không mở transaction.
8. Mở **một** interactive transaction [S32]:

```ts
await this.prisma.$transaction(async (tx) => {
  // (a) tùy chọn, chỉ PostgreSQL: khóa dòng board và đọc last_seq trong một câu [S41]
  const [{ last_seq }] = await tx.$queryRaw<{ last_seq: number }[]>`SELECT last_seq FROM boards WHERE id = ${boardId}::uuid FOR UPDATE`;
  // (b) gán seq = last_seq + 1, + 2... cho các op được nhận, theo đúng thứ tự
  // (c) ghi element: create cho add, update theo khóa kép cho phần còn lại
  //     where: { boardId_id: { boardId, id } }   ← tên mặc định ghép từ các field của @@id [S36]
  // (d) tx.operation.createMany({ data: [...] }), payload = resolvedOp, không phải op gốc
  // (e) tx.board.update({ where: { id: boardId }, data: { lastSeq: newLastSeq } })
}, { timeout: 10_000 });   // mặc định maxWait 2000 ms, timeout 5000 ms [S32][S33]
```

9. Sau khi transaction resolve, **vẫn đang trong lock**, gọi `socketEmitter.toBoard(boardId, 'OpsApplied', applied)`. Phát trong lock thì thứ tự phát trùng thứ tự `seq`. `BoardService → SocketEmitter` là chiều service → `infra/`, hợp lệ.
10. Trả kết quả cho gateway. Gateway gửi `OpRejected` riêng cho người gửi và trả ack.

**Op `clear`** (đi đường riêng, vẫn trong lock và transaction):

- `tx.element.updateMany({ where: { boardId, isDeleted: false, locked: false }, data: { isDeleted: true, version: { increment: 1 } } })`.
- Ghi một dòng `operations` với `elementId: null`.

`clear` dùng `updateMany` vì nó lọc theo `boardId`, không cần khóa kép. Docs chỉ cam kết khóa kép cho các query unique (`findUnique`, `update`, `upsert`, `delete`) [S36].

**Test nên viết** (`board.service.spec.ts`, dùng DB test thật hoặc SQLite; mock Prisma cho logic này thường không đáng):

- Lô 3 op: op 2 trỏ tới element đã xóa. Kết quả: op 1 và 3 có `seq` liên tiếp, op 2 nằm trong `rejected`, `last_seq` tăng 2.
- Gửi lại cùng lô hai lần: lần hai toàn `duplicates`, `last_seq` không đổi, không phát `OpsApplied`.
- 20 lệnh `submitOps` song song trên một bảng (`Promise.all`): `seq` từ 1 đến N không trùng không hổng, `version` cuối bằng số update.
- Ép lỗi DB giữa transaction (ví dụ `opId` không phải UUID ở tầng dưới DTO): không có dòng `elements` hay `operations` nào được ghi, và `last_seq` giữ nguyên.
- `reorder front`: `operations.payload` chứa zIndex cụ thể.

**Bẫy có thể xảy ra:**

1. **Race khi không có lock.**
   - Mỗi `await` là một chỗ để tin khác chen vào (7.1). Hai lô cùng đọc `last_seq = 10` rồi cùng ghi `seq = 11`: một transaction chết vì khóa chính `(board_id, seq)`, hoặc tệ hơn, cả hai đọc cùng một element và một bản ghi đè mất patch của bản kia.
   - `BoardLocks` chống được việc này trong một process.
   - Câu `SELECT ... FOR UPDATE` ở bước 8a là lưới an toàn thứ hai, chạy được cả khi nhiều process. Docs Postgres: các transaction khác "will be blocked until the current transaction ends" [S41]. Nhưng nó chỉ khóa từ lúc transaction bắt đầu, nên bước 3 phải đọc lại element **trong** `tx` nếu bạn dựa vào nó thay cho `BoardLocks`.
   - SQLite không có `FOR UPDATE`. Chỉ thêm câu này khi đã sang Postgres.
2. **Lưu op gốc thay vì op đã resolve.** Lưu `{ type: 'reorder', position: 'front' }` thì khi phát lại trong `MissedOps`, mỗi client tự tính "front" theo trạng thái của nó và ra kết quả khác nhau. `OpsApplied` và `operations.payload` đều phải chứa giá trị cuối do server quyết định (zIndex, version mới).
3. **Bắt `P2002` rồi tiếp tục trong cùng transaction.**
   - Trên Postgres, sau một câu lệnh lỗi, transaction rơi vào "aborted state" và chỉ `ROLLBACK TO` savepoint mới cứu được [S42].
   - Vì vậy đừng `try/catch` P2002 bên trong callback rồi chạy tiếp. Lọc trùng **trước** transaction (bước 2).
   - Nếu P2002 vẫn xảy ra (hai process), bắt nó **bên ngoài** `$transaction`: chạy lại cả bước 2–9 một lần. Lần chạy lại sẽ lọc op trùng.
   - Đừng dùng `createMany({ skipDuplicates: true })` để "lờ đi" op trùng: element đã bị áp rồi, và option này không chạy trên SQLite [S37].
   - Kiểm tra bằng `e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'` [S34]. Đừng dựa vào `e.meta.target`. Docs chỉ đưa nó làm ví dụ, không cam kết cho P2002, nhất là khi dùng driver adapter [S34].
4. **Giữ lock trong lúc làm I/O chậm.** Lock chỉ nên bọc "đọc, áp, ghi DB, phát". Không upload file, gọi HTTP hay gửi mail trong `run()`. Docs Prisma cũng khuyên "Try to avoid performing network requests and executing slow queries inside your transaction functions" [S32].
   - Thêm trần hàng đợi cho mỗi bảng, ví dụ 50 việc đang chờ: vượt thì từ chối `busy`.
   - Một việc treo sẽ chặn cả bảng. Timeout của transaction chặn được phần DB, còn các `await` khác thì không.
5. **Timeout mặc định của transaction là 5 giây** [S32][S33].
   - 100 op làm 100 lần `update` riêng lẻ, mỗi lần một round-trip. Với DB ở xa (20 ms một lần) là 2 giây, sát ngưỡng.
   - Gom đọc thành một `findMany`, ghi op bằng `createMany`, và đặt `timeout` rõ ràng.
   - Có thể đặt mặc định cho cả client qua `transactionOptions` trong constructor `PrismaClient` [S33].
   - Hết giờ thì transaction bị rollback, và bạn phải coi cả lô thất bại.
6. **Rò bộ nhớ trong Map của lock.** Bỏ dòng `if (this.tails.get(boardId) === next) this.tails.delete(boardId)` thì Map giữ một Promise cho mỗi bảng từng có người vẽ. Test `size() === 0` bắt được lỗi này.
7. **BigInt.**
   - `seq Int` (int4, tối đa khoảng 2,1 tỉ) là đủ. Spec chọn `Int` vì `JSON.stringify` không serialize được BigInt (chạy thử: `TypeError: Do not know how to serialize a BigInt`).
   - Lưu ý: `$queryRaw` trả số nguyên 64-bit dưới dạng `BigInt` [S38]. Một `COUNT(*)` hay `max(seq)` kiểu `bigint` trong raw SQL sẽ làm hỏng `emit` của Socket.IO. Ép kiểu trong SQL (`::int`) hoặc `Number(x)` trước khi trả về.
8. **Kích thước payload JSON.**
   - Nét vẽ 5.000 điểm dạng `[123.45,678.9]` nặng khoảng 75 KB. Spec đề xuất hạ `maxHttpBufferSize` xuống 100 KB. Vượt ngưỡng thì Socket.IO **đóng socket**, không chỉ từ chối tin: "maximum size … of a single message before the socket is closed" [S21].
   - Client tự kết nối lại, gửi lại đúng lô đó, rồi lại bị đóng. Thành vòng lặp.
   - Client phải chia lô theo **byte** (chạy `JSON.stringify` thử trước khi gửi) và làm tròn tọa độ. Chọn ngưỡng server đủ cho một nét tối đa cộng phần đệm.
9. **`opId` không phải UUID.** Cột `op_id` là `@db.Uuid`, nên chuỗi sai định dạng làm Postgres ném lỗi, client thấy lỗi 500 chung chung. Dùng `@IsUUID()` trong DTO. Áp dụng tương tự cho `boardId` ở `JoinBoard`.

---

## 3. Realtime gateway (GĐ1, phần ephemeral và rate limit ở GĐ3)

File:

- `realtime/board.gateway.ts`, `realtime/presence-tracker.ts` (+ spec).
- `realtime/token-bucket.ts` (+ spec), một class thuần.
- `realtime/events.ts`: interface sự kiện dùng chung.
- `realtime/dto/*`.
- `infra/socket/socket-emitter.service.ts`.

### 3.1 API NestJS / Socket.IO cần dùng

- Lifecycle hook [S1]:
  - `OnGatewayInit.afterInit(server)` nhận server gốc.
  - `OnGatewayConnection.handleConnection(client)`.
  - `OnGatewayDisconnect.handleDisconnect(client)`.
- Decorator:
  - `@WebSocketServer()`, `@SubscribeMessage('X')`, `@MessageBody()`, `@ConnectedSocket()`.
  - `@Ack()` để tự gọi ack.
  - Giá trị `return` của handler được gửi làm acknowledgement. `null` / `undefined` thì không gửi gì [S1].
  - Trả `{ event, data }` thì Nest gửi một sự kiện có tên đó [S1].
- **Nest không chờ `handleConnection()` async xong rồi mới xử lý tin của client.** Muốn chặn sớm thì dùng middleware `server.use()` trong `afterInit()` [S1].
- Option của gateway truyền thẳng xuống Socket.IO, có `maxHttpBufferSize`, `cors`, `transports`, `pingInterval`… (đọc `GatewayMetadata` của `@nestjs/websockets@12.2.0` [S18]). Mặc định: `maxHttpBufferSize` 1e6, `pingInterval` 25000, `pingTimeout` 20000, `connectionStateRecovery` undefined [S21].
- Typed events: `Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>`. `SocketData` gõ kiểu cho `socket.data`. Phía client dùng cùng interface nhưng đảo vai [S25].
- Phát tin:
  - `server.to(room).emit()` gửi cả phòng.
  - `socket.to(room).emit()` gửi "every socket in the room excluding the sender" [S23].
  - `server.in(room).disconnectSockets(close?)` ngắt socket [S20].
  - `socket.volatile` gửi tin có thể mất nếu client chưa sẵn sàng [S20]. Hợp với con trỏ.
- Tên sự kiện cấm dùng: `connect`, `connect_error`, `disconnect`, `disconnecting`, `newListener`, `removeListener` [S24].

### 3.2 `SocketEmitter` (module lá ở `infra/socket/`)

Code mẫu ở UC 5.6 của spec đã đúng. Chỉ cần thêm:

1. Gõ kiểu `toBoard<E extends keyof ServerToClientEvents>(boardId, event: E, ...args: Parameters<ServerToClientEvents[E]>)`, để gõ sai tên sự kiện là lỗi compile.
2. Thêm `disconnectRoom(room: string)`. Mục 7 dùng hàm này cho `share:` và `member:`.
3. `bind()` chỉ được gọi một lần. Nếu `server` chưa được gán mà có ai gọi `toBoard` thì `logger.warn`, đừng im lặng nuốt.

**Bẫy:** job hoặc service gọi emitter trước khi `afterInit` chạy thì `this.server?.` lặng lẽ không làm gì. Lịch chạy của `@nestjs/schedule` chỉ bắt đầu ở `onApplicationBootstrap` [S8], nên job thường đến sau `afterInit`. Nhưng đừng giả định thứ tự đó: warning sẽ nói thật.

### 3.3 `afterInit`: bind emitter + middleware kết nối

```ts
afterInit(server: Server<C2S, S2C, {}, SocketData>) {
  this.emitter.bind(server);
  server.use((socket, next) => {
    // GĐ4: xác thực JWT ở đây (mục 6.2). GĐ1: chỉ khởi tạo dữ liệu.
    socket.data.buckets = createBuckets();             // token bucket theo từng socket (3.7)
    socket.use(([event], nextPacket) => this.rateLimit(socket, event, nextPacket));
    next();
  });
}
```

- Middleware của `server.use` chạy "only once per connection" [S22], **trước** mọi packet. Vì vậy đăng ký per-packet middleware (`socket.use`) ở đây thì không packet nào lọt.
- `socket.use(([event, ...args], next) => ...)` chạy cho mọi packet đến [S20].

### 3.4 `JoinBoard`

**DTO:**

- `@IsUUID() boardId`.
- `@IsString() @MaxLength(50) displayName`.
- `@IsOptional() @IsInt() @Min(0) lastSeq`.
- `@IsOptional() @IsString() shareToken`.
- `@IsUUID() clientId`: id cố định trên localStorage (UC 1.4).

**Logic từng bước:**

1. Socket đã ở bảng khác (`client.data.boardId` có giá trị và khác): rời room cũ, gỡ presence cũ (giống 3.6), rồi mới tiếp tục. Quy tắc: một socket, một bảng.
2. Xác định vai trò:
   - GĐ1–3: bảng tồn tại thì `editor`, không thì trả ack `{ ok: false, reason: 'not_found' }`.
   - GĐ4: gọi `sharingService.resolveRole(userId, boardId, shareToken)` (mục 7). Không có quyền `view` thì từ chối.
3. **Vào room và chụp trạng thái nhất quán, cả hai trong `BoardLocks.run(boardId)`.** Gateway không gọi `BoardLocks` trực tiếp. Nó gọi một hàm service, ví dụ `boardService.joinConsistently(boardId, lastSeq, beforeRead: () => client.join(rooms))`. Trong lock, hàm đó:
   1. `await beforeRead()`: `client.join(['board:'+boardId, ...])`. `join` có kiểu trả về `void | Promise` [S20], nên luôn `await`.
   2. Đọc state:
      - Không có `lastSeq` thì đọc element chưa xóa cộng `last_seq`.
      - Có `lastSeq` thì chạy logic `MissedOps` (mục 4).
   3. Emit `BoardState` hoặc `MissedOps` cho riêng client này, **vẫn trong lock**.

   Vì `OpsApplied` cũng được phát trong lock (2.3 bước 9), client không bao giờ lỡ hay nhận trùng op nằm giữa "đọc state" và "vào room".
4. Gán `client.data = { boardId, role, clientId, userId?, displayName, color, ... }` **sau** khi mọi bước trên thành công. Mọi handler khác coi "có `boardId`" nghĩa là "đã join xong".
5. `presence.add(boardId, client.id, info)` trả về `isFirstTabOfClient`. Chỉ khi `true` mới gửi `client.to(room).emit('UserJoined', ...)` (lưu ý ở UC 1.5).
6. `BoardState` gồm:
   - Element sort theo zIndex (sort trong JS bằng `<` hoặc dùng cột collation `"C"`).
   - `lastSeq`.
   - `presence.list(boardId)` đã gom theo `clientId`.
   - Selection hiện tại và danh sách ai đang sửa ô chữ nào.
7. Trả ack `{ ok: true, role }`.

**Bẫy:**

- **Tin `boardId` client gửi.** Mọi handler sau `JoinBoard` phải đọc từ `client.data.boardId` (8.2). Payload của `SubmitOps` và `UpdateCursor` không nên có trường `boardId`. Có thì server bỏ qua.
- **Emit trước khi join xong.** Gửi `BoardState` trước `await client.join()` thì `OpsApplied` phát giữa hai bước đó sẽ không tới client.
- **Client gửi op trước khi join xong, nhất là lúc kết nối lại.** Client Socket.IO lưu đệm sự kiện khi mất mạng và gửi ngay khi có kết nối [S27]. `SubmitOps` cũ có thể đến **trước** `JoinBoard`. Handler `SubmitOps` phải trả `{ ok: false, reason: 'not_joined' }` khi chưa có `client.data.boardId`. Phía client không `emit` op khi `socket.connected === false`; giữ op trong hàng đợi riêng và chỉ gửi sau ack của `JoinBoard`.
- **Đọc state không nhất quán.** Đọc element và `last_seq` bằng hai query riêng ở READ COMMITTED (mặc định của Postgres [S32]) có thể thấy hai thời điểm khác nhau. Đọc trong lock (cách trên), hoặc trong transaction `isolationLevel: RepeatableRead` [S32].

### 3.5 `PresenceTracker`

**Cấu trúc:** `Map<boardId, Map<socketId, PresenceInfo>>`, với `PresenceInfo = { clientId, userId?, displayName, color, selection: string[], editingElementId?: string }`.

**Hàm:**

- `add(boardId, socketId, info) → { isFirstTabOfClient }`.
- `remove(socketId, boardId) → { clientId, isLastTabOfClient, releasedEditing: string[] } | undefined`.
- `list(boardId)`: gom theo `clientId`, mỗi người một dòng.
- `setSelection(...)`.
- `tryBeginTextEdit(boardId, elementId, socketId) → boolean`: khóa mềm (7.3).
- `endTextEdit(...)`.
- `isEditedByOther(boardId, elementId, socketId)`.
- Màu: tính từ hash của `clientId`, để hai tab của cùng một người có cùng màu.

**Test:**

- 2 tab cùng `clientId`: add, add, remove. Chưa "rời phòng". Remove lần nữa thì `isLastTabOfClient`.
- Bảng hết người thì Map ngoài bị xóa khóa `boardId`.
- Khóa mềm: tab B không lấy được khi A đang giữ. A ngắt kết nối thì khóa được nhả.
- `list` không lộ `socketId`.

**Bẫy:**

- Không xóa Map con khi rỗng thì rò bộ nhớ theo số bảng.
- `clientId` do client tự khai nên giả mạo được. Trước GĐ4, nó chỉ dùng để hiển thị. Từ GĐ4, gom theo `userId` nếu có.
- Khóa mềm chỉ có tác dụng nếu gateway lọc op `update` có patch `text` lên element mà người khác đang sửa (gọi `isEditedByOther` trước khi chuyển cho service). Spec chưa có tên sự kiện cho "bắt đầu/thôi sửa chữ". Gọn nhất là thêm trường `editingElementId?` vào `UpdateSelection`.

### 3.6 `handleDisconnect`

1. Đọc `client.data.boardId`. **Đừng** đọc `client.rooms`: khi `disconnect` chạy, socket đã rời mọi room. Chỉ sự kiện `disconnecting` mới còn thấy room [S23].
2. `presence.remove(...)`. Nếu `isLastTabOfClient` thì `server.to(room).emit('UserLeft', ...)`.
3. Có khóa mềm bị nhả thì phát `SelectionChanged` cho phòng.
4. Xóa timer riêng của socket nếu có (ví dụ timer hết hạn token ở 6.2). Bucket nằm trong `client.data` nên chết cùng socket.

### 3.7 Ephemeral relay + token bucket

**Khuôn chung cho `UpdateCursor`, `UpdateSelection`, `UpdateViewport`, `SendEphemeral`:**

1. Chưa join thì bỏ qua. Ephemeral không cần báo lỗi.
2. `can(role, 'sendPresence')`, nếu không thì bỏ qua.
3. Validate:
   - `x`, `y`, `zoom` là số hữu hạn.
   - `kind ∈ {laser, emote, cursorChat, dragPreview, strokeProgress}`.
   - `cursorChat` tối đa N ký tự. Selection tối đa M id.
4. Server tự gắn `clientId` / `color` từ `client.data`. Không chuyển tiếp danh tính do client khai.
5. `client.to('board:'+boardId).volatile.emit('CursorMoved', ...)`.
   - `UpdateSelection` thì lưu vào presence trước, rồi mới phát (4.3).
   - `dragPreview` / `strokeProgress` (UC 1.2, 2.5) thì không cần `volatile`, nhưng vẫn qua bucket.

**Token bucket** (`token-bucket.ts`):

- Mô hình chuẩn có tốc độ nạp và kích thước xô (CIR/CBS trong RFC 2697 [S53]).

```ts
class TokenBucket {
  constructor(private capacity: number, private refillPerSec: number, private now: () => number = () => performance.now()) {}
  tryTake(): boolean   // nạp lười: tokens = min(cap, tokens + (now - last) * rate / 1000); còn ≥ 1 thì trừ 1 và trả true
}
```

- Mỗi socket giữ một bucket cho mỗi nhóm: `ops` (30/s), `presence` (30/s), `other`.
- Trong `socket.use`, hết lượt thì **không gọi `nextPacket()`**: packet bị bỏ, không tới handler.
- Đếm số lần vi phạm. Vượt ngưỡng (ví dụ 100 lần trong 10 s) thì `socket.disconnect(true)` (8.3: "lần đầu bỏ qua tin, nhiều lần thì ngắt").
- **Test:** truyền đồng hồ giả. Lấy liên tục `capacity` lần thì OK, lần tiếp theo thì `false`. Tua đồng hồ 1 s thì có lại `refillPerSec` lượt. Không bao giờ vượt `capacity`.

**Bẫy:**

- **Gọi `nextPacket(new Error(...))` trong `socket.use`.** Socket.IO 4.8.4 phát lỗi đó thành sự kiện `error` trên socket server [S20][S31]. Socket là EventEmitter, nên phát `error` mà không có listener sẽ ném exception (hành vi chuẩn của Node EventEmitter). Gọn nhất: bỏ packet bằng cách **không gọi** `nextPacket`. Nếu muốn báo lỗi thì phải đăng ký `socket.on('error', ...)`.
- `@nestjs/throttler` có hỗ trợ WebSocket, nhưng phải kế thừa `ThrottlerGuard`, override `handleRequest`, không được đăng ký global, và hết lượt thì Nest phát sự kiện `exception` [S13]. Token bucket trong `socket.use` gọn hơn cho một app một process. Giữ throttler cho REST (mục 10.4).

### 3.8 `SubmitOps` handler

1. Chưa join thì ack `{ ok: false, reason: 'not_joined' }`.
2. `can(role, 'submitOps')`. Có op `clear` thì cần `clearOrRestoreVersion`. Có patch `locked` thì cần `lockElement`.
3. Lọc op `text` đang bị người khác khóa mềm (3.5).
4. Gọi `boardService.submitOps(client.data.boardId, actor, dto.ops)`.
5. Với mỗi op bị từ chối: `client.emit('OpRejected', { opId, reason, current })`. `OpRejected` chỉ gửi người gửi (5.3).
6. Trả ack `{ ok: true, applied: [{opId, seq, version}], rejected, duplicates }`. `OpsApplied` đã được service phát cho cả phòng, kể cả người gửi.

**Ack hay emit?** Ack (giá trị `return`) chỉ tới người gửi, một lần [S1]. Hợp để client biết "lô này xong" và dọn hàng đợi. `OpsApplied` là sự kiện cho cả phòng. Dùng cả hai như trên.

**Bẫy:**

- **Lỗi trong handler không thành ack.**
  - Khi handler ném lỗi, filter WS mặc định emit sự kiện `exception` với `{ status, message, cause }`, không gọi ack [S2][S18]. Client dùng `emitWithAck` sẽ chờ tới hết timeout.
  - `cause` mặc định **gửi lại nguyên payload** của client [S2][S18]. Một lô 100 op sẽ bị dội về. Đặt `includeCause: false` (10.1).
  - Với `SubmitOps`, hãy `try/catch` trong handler và trả `{ ok: false, reason }`.
- **ValidationPipe toàn cục không hợp với gateway.** Pipe global (`useGlobalPipes`) **có** áp cho gateway, nhưng `BadRequestException` của nó tới client thành "Internal server error" [S3]. Pipe global chạy **trước** pipe gắn ở gateway hay tham số. Vì vậy thêm `exceptionFactory` ở gateway mà vẫn giữ pipe global thì không cứu được: setup-guide đã chạy thử và thấy client vẫn nhận "Internal server error". Có hai cách đúng:
  - **Cách dùng trong dự án này:** giữ pipe global và gắn `@UseFilters(WsExceptionFilter)` lên gateway. Filter đổi `BadRequestException` thành `WsException`. Xem `setup-guide.md` bước 7.3.
  - **Cách khác:** bỏ pipe global, gắn pipe riêng cho REST, và gắn cho gateway `new ValidationPipe({ ..., exceptionFactory: (errors) => new WsException(errors) })` ở `@MessageBody(...)`. Pipe ở cấp method hay gateway chạy trên **mọi** tham số của handler [S3].

- **Gõ sai tên sự kiện.** `'OpsAplied'` chạy im lặng và không ai nhận. Khai báo `ServerToClientEvents` / `ClientToServerEvents` trong `events.ts`. Dùng chúng làm generic cho `Server` / `Socket` [S25], và dùng hằng `ClientEvents.SubmitOps` trong `@SubscribeMessage(...)`. Copy cùng file đó sang frontend.

### 3.9 `Ping` / `Pong`

1. Client gửi `Ping({ clientTime: t0 })`.
2. Handler `return { event: 'Pong', data: { clientTime, serverTime: Date.now() } }`. Nest phát sự kiện `Pong` cho người hỏi [S1].
3. Client nhận ở thời điểm `t1` và tính `offset = serverTime − (t0 + t1) / 2`. Đây là công thức offset của NTP khi coi T2 = T3 [S54]. Đo vài lần, giữ mẫu có `t1 − t0` nhỏ nhất.

**Bẫy:** server đếm ngược từng giây thay vì gửi thời điểm kết thúc (UC 5.6). Server chỉ gửi `endsAt` (UTC ms) một lần.

---

## 4. Kết nối lại: `MissedOps` (GĐ3)

File: `board/operation.service.ts`, được gọi từ `joinConsistently` (3.4).

**Logic từng bước** (trong `BoardLocks.run`):

1. Đọc `board.lastSeq`.
2. `lastSeq > board.lastSeq` thì gửi `BoardState`: client đang ở "tương lai", ví dụ sau khi DB bị reset.
3. `lastSeq === board.lastSeq` thì gửi `MissedOps([])`.
4. Còn lại, đọc op với seq > lastSeq theo thứ tự tăng dần, lấy tối đa THRESHOLD + 1 dòng (ví dụ THRESHOLD = 1000):

```ts
const ops = await prisma.operation.findMany({ where: { boardId, seq: { gt: lastSeq } }, orderBy: { seq: 'asc' }, take: THRESHOLD + 1 });
```

5. Gửi `BoardState` thay vì `MissedOps` khi gặp một trong ba trường hợp:
   - `ops.length > THRESHOLD` (7.5 bước 4).
   - **`ops[0].seq !== lastSeq + 1`**: có khoảng hổng vì op cũ đã bị dọn (mục 8).
   - Trong `ops` có op `restore_snapshot`: client không áp được dần op đó.
6. Còn lại thì gửi `MissedOps(ops.map(o => o.payload + seq))`, cùng định dạng với `OpsApplied`.
7. Client áp các op lỡ, xóa khỏi hàng đợi những op có `opId` của chính mình, rồi gửi lại phần còn lại. Server lọc trùng bằng `opId` (2.3 bước 2). Kết quả: gửi lại bao nhiêu lần cũng như nhau.

**Test (e2e với `socket.io-client`):**

- A ngắt mạng, B vẽ 5 op, A nối lại với `lastSeq`: A nhận đúng 5 op.
- B vẽ 1.001 op: A nhận `BoardState`.
- Xóa thủ công op cũ: A nhận `BoardState`.
- A gửi lại một op đã được nhận: nó vào `duplicates`, `last_seq` không đổi.

**So sánh với Connection State Recovery (CSR) của Socket.IO:**

| | `lastSeq` + `operations` (thiết kế này) | Socket.IO CSR |
|---|---|---|
| Phạm vi | Mọi khoảng mất mạng, kể cả server khởi động lại, miễn op còn trong DB | Chỉ trong `maxDisconnectionDuration`. Tính năng nhắm tới "intermittent disconnections" [S26] |
| Độ chắc chắn | Biết chắc khi nào phải gửi `BoardState` (dựa vào khoảng hổng seq) | "the recovery will not always be successful", vẫn phải tự xử lý đồng bộ [S26] |
| Adapter | Không phụ thuộc | Adapter in-memory được. **Redis adapter (pub/sub) không được**. Redis Streams, MongoDB được [S26] |
| Bảo mật | Mỗi lần nối lại đều qua middleware và `JoinBoard` | `skipMiddlewares: true` có thể cho người vừa bị chặn vào lại [S21][S26]. Socket được khôi phục giữ nguyên `data` và room [S26], tức là giữ cả **vai trò cũ** |

**Đề xuất: không bật CSR.** Nó không thay được `MissedOps`, mà còn làm hỏng việc thu hồi quyền (mục 7) và UC 8.4 (Redis). Khi làm UC 8.4, docs Nest nhắc thêm: "Redis alone is not enough", cần sticky session hoặc client chỉ dùng `transports: ['websocket']` [S5]. Đây cũng đúng là mẫu "at least once" mà docs Socket.IO tự gợi ý: mỗi sự kiện có id, lưu DB, client giữ offset, nối lại thì phát bù [S27].

**Bẫy:**

- Dọn op cũ mà không có kiểm tra khoảng hổng thì client nhận `MissedOps` thiếu và lệch trạng thái mãi mãi.
- Đọc `MissedOps` ngoài lock thì op mới chen vào giữa lúc đọc và lúc join (giống 3.4).
- Option `retries` / `ackTimeout` của client [S29] có thể gửi lại `SubmitOps` khi ack chậm. Server chịu được nhờ dedupe `opId`, nên bật chúng là an toàn.

---

## 5. Upload asset (GĐ2)

File: `modules/asset/{asset.module, asset.controller, asset.service}.ts`, `infra/storage/{storage.interface, local-disk.storage, storage.module}.ts`.

**Thư viện:** `FileInterceptor` (`@nestjs/platform-express`), `@UploadedFile()`, `ParseFilePipe` với `MaxFileSizeValidator` và `FileTypeValidator` [S6], `StreamableFile` [S7].

### 5.1 Upload: `POST /api/boards/:id/assets`

```ts
@Post(':id/assets')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))   // multer dừng sớm → 413
upload(@Param('id', ParseUUIDPipe) boardId: string,
       @UploadedFile(new ParseFilePipe({ validators: [
         new FileTypeValidator({ fileType: /^image\/(png|jpeg|gif|webp)$/, overrideMimeType: true }),
       ] })) file: Express.Multer.File) { ... }
```

**Logic từng bước:**

1. Kiểm tra bảng tồn tại và người gọi có quyền `submitOps` (GĐ4).
2. `limits.fileSize` trên interceptor: multer dừng nhận ngay khi vượt, Nest đổi `LIMIT_FILE_SIZE` thành `PayloadTooLargeException` (413) [S19]. Docs dặn "always set `limits.fileSize`" khi file nằm trong bộ nhớ [S6].
3. `FileTypeValidator` của Nest 12 **mặc định kiểm tra magic number** bằng `file-type` (`fileTypeFromBuffer`), không chỉ tin `mimetype` [S6][S17].
   - `overrideMimeType: true` thay `file.mimetype` bằng loại phát hiện được từ nội dung [S17].
   - Đừng bật `skipMagicNumbersValidation` hay `fallbackToMimetype`.
4. Sinh `assetId = crypto.randomUUID()`. **Server** chọn đuôi file từ mime đã phát hiện (`image/png` thành `.png`). `storageKey = ${boardId}/${assetId}.png`. Không dùng `file.originalname`, vì multer ghi rõ "`file.originalname` is always client-supplied and should be treated as untrusted" [S65]. OWASP cũng khuyên đặt tên ngẫu nhiên bằng UUID [S58].
5. `await storage.put(storageKey, file.buffer, mime)`, rồi tạo dòng `assets`. Nếu tạo dòng lỗi thì xóa file vừa ghi.
6. Trả `{ assetId, url: /api/assets/${assetId} }`.

### 5.2 Storage interface + ổ đĩa

```ts
export const STORAGE = Symbol('STORAGE');
export interface Storage { put(key: string, data: Buffer, contentType: string): Promise<void>; read(key: string): Promise<Readable>; delete(key: string): Promise<void>; }
```

`LocalDiskStorage`:

- `root = path.resolve(env.UPLOAD_DIR)`, `full = path.resolve(root, key)`.
- **Bắt buộc** kiểm tra `full.startsWith(root + path.sep)`, không thì ném lỗi.
- Tạo thư mục bằng `mkdir(..., { recursive: true })`.
- Thư mục upload nằm **ngoài** thư mục được serve static. OWASP: "store them outside of the webroot" [S58].

### 5.3 Serve: `GET /api/assets/:id`

1. `ParseUUIDPipe`. Đọc dòng `assets`. GĐ4: kiểm tra người xem có quyền `view` trên `asset.boardId`.
2. `return new StreamableFile(await storage.read(asset.storageKey), { type: asset.mimeType, length: asset.sizeBytes })` [S7].
3. Đặt header `X-Content-Type-Options: nosniff` và `Cache-Control` (asset bất biến nên cache lâu được). Header này không có trong hai nguồn đã đọc; xem "Chưa xác minh".

### 5.4 Test và bẫy

**Test e2e (supertest):**

- PNG thật thì 201.
- File `.exe` đổi tên thành `.png` và gửi `Content-Type: image/png` thì 400.
- File 11 MB thì 413.
- SVG thì 400.
- `GET` với id lạ thì 404.
- `LocalDiskStorage.put('../../x', ...)` ném lỗi (unit test).

**Bẫy có thể xảy ra:**

1. **Giả mạo mimetype.** `Content-Type` do client đặt. OWASP: "don't trust the Content-Type header as it can be spoofed" [S58]. Magic byte giúp, nhưng OWASP cũng nói chỉ kiểm tra chữ ký thì không đủ, vì "bypassing it is pretty common". Đòn mạnh nhất là decode rồi encode lại ảnh [S58]. Với dự án học, magic byte cộng allowlist là đủ.
2. **`diskStorage` làm mất magic byte check.** `FileTypeValidator` cần `file.buffer`. Không có buffer thì nó trả false, trừ khi bật `fallbackToMimetype` [S17]. Giữ `memoryStorage` mặc định [S6], rồi tự ghi qua `Storage`.
3. **Hết bộ nhớ.** `memoryStorage` với file lớn hoặc nhiều file cùng lúc "can cause your application to run out of memory" [S65]. Đặt `limits.fileSize`, `files: 1`, và rate limit endpoint (10.4).
4. **Path traversal** nếu `storageKey` ghép từ input. Key chỉ gồm UUID do server sinh, và vẫn kiểm tra `startsWith(root)`.
5. **SVG là nơi chứa XSS.** Đừng cho vào allowlist. OWASP cảnh báo chung về "Client-side active content" trong file upload [S58].
6. **Op `image` trỏ tới asset của bảng khác.** Khi áp `add` loại `image`, service kiểm tra `assets.boardId === boardId`.
7. **Không gắn multer làm middleware global.** README multer cảnh báo điều này [S65]. Chỉ dùng `FileInterceptor` trên đúng route.

---

## 6. Auth (GĐ4)

File: `modules/auth/{auth.controller, auth.service, strategies/jwt.strategy, strategies/google.strategy, dto/}`, `modules/user/`, `common/guards/jwt-auth.guard.ts`, `common/decorators/{current-user, public}.decorator.ts`.

### 6.1 REST: passport-jwt

Recipe chính thức [S14]:

- `class JwtStrategy extends PassportStrategy(Strategy)` với `jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken()`, `ignoreExpiration: false`, `secretOrKey`.
- Giá trị `validate(payload)` trả về trở thành `req.user`.
- `JwtAuthGuard extends AuthGuard('jwt')` đăng ký global, kèm decorator `@Public()` dựa trên `SetMetadata` + `Reflector`.

Thêm `algorithms: ['HS256']`, và `issuer` / `audience` nếu dùng. Đây là các option của passport-jwt [S63].

**Đăng ký / đăng nhập, từng bước:**

1. Validate DTO: email, mật khẩu ≥ 8 ký tự và **≤ 72 byte nếu dùng bcrypt** (OWASP [S57]), `displayName ≤ 50`.
2. Băm mật khẩu bằng `argon2.hash(password)`. Gói `argon2@0.45.1` mặc định dùng argon2id với `timeCost = 3`, `memoryCost = 65536` (64 MiB), `parallelism = 4` [S66]. Mức này vượt mức tối thiểu OWASP (m = 19 MiB, t = 2, p = 1) [S57].
3. Lưu user. Email trùng gây `P2002`: trả 409 (10.1).
4. Đăng nhập:
   - `argon2.verify(hash, password)`.
   - Sai thì trả **cùng một** thông báo cho cả "không có email" lẫn "sai mật khẩu".
   - Đúng thì ký access token ngắn hạn (15 phút) bằng `JwtService`, với `sub = userId`.

**argon2 hay bcrypt:**

- OWASP xếp Argon2id đầu tiên, rồi scrypt, rồi bcrypt (bcrypt "chỉ cho hệ thống cũ").
- bcrypt chỉ dùng tối đa 72 byte đầu vào, và pre-hash có rủi ro [S57].
- **Chọn argon2.** Docs Nest v12 thì dùng scrypt trong package mới `@nestjs/authentication` [S15]. scrypt cũng hợp lệ theo OWASP.

### 6.2 WebSocket: JWT trong middleware kết nối

1. Client: `io(url, { auth: { token } })` [S22]. Nên dùng dạng hàm `auth: (cb) => cb({ token: getFreshToken() })` [S29].
2. Trong middleware `server.use` (3.3):
   - Đọc `socket.handshake.auth?.token` [S20] và gọi `await jwtService.verifyAsync(token)`.
   - Đúng thì gán `socket.data.userId = payload.sub` và `socket.data.tokenExp = payload.exp`.
   - Sai thì `next(new Error('unauthorized'))`. Client nhận `connect_error` [S22].
   - Khách không token (nếu cho vào bằng link, câu hỏi 10.3 của spec): cho qua, `userId` để trống.
3. Hết hạn giữa chừng: middleware chỉ chạy lúc bắt tay [S22]. Mỗi lần `SubmitOps`, kiểm tra `Date.now()/1000 < client.data.tokenExp`. Hết hạn thì emit `AuthExpired` rồi `client.disconnect()`. Cách khác là đặt `setTimeout` tới `exp` (nhớ `clearTimeout` ở 3.6).

**Bẫy:**

- **Chỉ dựa vào guard.** Guard chạy theo từng tin. Nest không chặn kết nối bằng `handleConnection` (nó không chờ hàm async) [S1]. Middleware mới là cổng. Guard vẫn có ích cho kiểm tra theo từng tin: guard trả `false` thì Nest ném `WsException('Forbidden resource')`. Guard global (`APP_GUARD`) cũng áp cho gateway [S4], nên `JwtAuthGuard` global của REST nên bỏ qua context `ws` (kiểm tra `context.getType()` [S10]). Guard đó đọc header HTTP mà một tin socket không có, nên nhiều khả năng sẽ chặn mọi tin (suy luận, chưa chạy thử).
- **`connect_error` do middleware từ chối không tự kết nối lại** (`socket.active === false`) [S28]. Client phải lấy token mới rồi gọi `socket.connect()`.
- **Ví dụ JWT chính thức của Socket.IO gửi token qua header `Authorization`** [S30]. Cách đó chỉ chạy khi long-polling đi trước, vì "browsers do not provide a way to provide additional headers for WebSocket connections" [S30]. Dùng `auth`, không dùng header.

### 6.3 Refresh token (ngắn gọn)

- Refresh token là chuỗi ngẫu nhiên `crypto.randomBytes(32).toString('base64url')` (43 ký tự, chạy thử [S67]). DB lưu **hash SHA-256** của nó cùng `familyId`, `expiresAt`, `revokedAt`.
- Mỗi lần refresh thì xoay vòng: cấp token mới, vô hiệu token cũ. Token cũ bị dùng lại là dấu hiệu bị lộ: thu hồi cả "family". Đây là cơ chế refresh token rotation của RFC 9700 §4.14.2 [S62]. Docs Nest v12 mô tả đúng hành vi này [S15].
- Web: đặt refresh token trong cookie `HttpOnly; Secure; SameSite`. Access token để trong bộ nhớ JS.

### 6.4 Google OAuth

- `passport-google-oauth20`: strategy nhận `clientID`, `clientSecret`, `callbackURL`, `scope` (README dùng `['profile']` và `state: true`). Verify callback có dạng `(accessToken, refreshToken, profile, cb)` [S64].
- Logic: tìm user theo `google_sub = profile.id`. Không có thì tạo mới, hoặc liên kết với user cùng email **đã xác minh**. Sau đó ký JWT như 6.1.
- **Bẫy:** liên kết tài khoản theo email chưa xác minh thì chiếm được tài khoản. README không nói gì về `email_verified` [S64]; xem "Chưa xác minh".

---

## 7. Sharing (GĐ4)

File: `modules/sharing/{sharing.module, sharing.service, share-link.controller, member.controller, dto/}`.

### 7.1 Tra vai trò khi `JoinBoard`

`resolveRole(userId | undefined, boardId, shareToken | undefined): Promise<{ role, via: 'owner' | 'member' | 'link', linkId? } | null>`

1. `board.ownerId === userId` thì `owner`.
2. Có dòng `board_members(boardId, userId)` thì lấy role của dòng đó.
3. Có `shareToken` thì tìm `share_links` theo **hash** của token (unique index 4.5), với `revokedAt == null` và `expiresAt > now`. Có thì lấy role của link.
4. Có cả vai trò thành viên lẫn link thì lấy vai trò **cao hơn**.
5. Không có gì thì `null` (từ chối).

Gateway cho socket vào thêm room:

- `member:${boardId}:${userId}`, nếu vào bằng tư cách owner hoặc member.
- `share:${linkId}`, nếu vào bằng link.

### 7.2 Tạo link, đổi vai trò, thu hồi

1. Tạo link (chỉ owner, `can(role, 'manageSharing')`):
   - `token = crypto.randomBytes(32).toString('base64url')`.
   - Lưu `sha256(token)`. Chỉ trả token thô **một lần** trong URL.
   - Hash trước khi lưu thì lộ DB không lộ link. Tra bằng hash thì không cần so sánh constant-time.
2. Thu hồi link: đặt `revokedAt = now`, rồi `socketEmitter.disconnectRoom('share:' + linkId)`, tức là `server.in(room).disconnectSockets()` [S20].
3. Đổi vai trò hoặc xóa thành viên: cập nhật `board_members`, rồi `disconnectRoom('member:' + boardId + ':' + userId)`.

**Test e2e:**

- Viewer gửi `SubmitOps` thì bị từ chối.
- Owner thu hồi link: socket vào bằng link bị ngắt, dùng lại token thì `JoinBoard` bị từ chối.
- Đổi editor thành viewer: socket của người đó **trên bảng này** bị ngắt, socket của họ trên bảng khác vẫn sống.

**Bẫy có thể xảy ra:**

1. **Ngắt theo room `user:{userId}` như ví dụ ở 5.6 / 8.2 của spec** sẽ ngắt người đó trên **mọi** bảng. `to()` / `in()` nhận mảng room là **hợp** các room, không phải giao [S20]. Muốn "người X trên bảng Y" thì phải có một room ghép tên như `member:{boardId}:{userId}`. Room `user:{userId}` vẫn hữu ích để gửi thông báo (mục 9).
2. **Spec 8.2 viết "client tự kết nối lại và nhận vai trò mới". Câu đó sai** khi server chủ động ngắt. Với lý do `io server disconnect`, client **không** tự kết nối lại [S28].
   - Cách sửa: phát `AccessChanged` cho room đó, rồi mới `disconnectSockets()`.
   - Client nhận `AccessChanged` thì tự gọi `socket.connect()` và `JoinBoard` lại.
   - Dùng `disconnectSockets()` không có `close: true`. Thứ tự gửi tin của Socket.IO được bảo đảm [S27], nên `AccessChanged` đến trước gói ngắt. Việc gói đó tới kịp trước khi transport đóng hẳn thì chưa kiểm chứng.
3. **Token trong URL bị ghi vào log** (access log, `Referer`). Đừng log query string của route vào phòng, và cho link có `expiresAt`.
4. **Chỉ kiểm tra `revokedAt` lúc `JoinBoard`** là đúng thiết kế (8.2: không query DB mỗi nét vẽ). Nhưng vì thế bắt buộc phải ngắt socket khi thu hồi. Quên bước 2 thì người bị thu hồi vẫn vẽ được tới khi tự F5.

---

## 8. Snapshot (GĐ4)

File: `modules/snapshot/{snapshot.module, snapshot.controller, snapshot.service, snapshot.scheduler}.ts`.

**API:**

- `ScheduleModule.forRoot()` chỉ gọi **ở một module** [S8].
- `@Interval('snapshot', 5 * 60_000)` có tên để điều khiển qua `SchedulerRegistry` [S8].
- Job bắt đầu ở `onApplicationBootstrap` [S8].

### 8.1 Job chụp định kỳ

1. Đầu hàm: `if (this.running) return; this.running = true; try { ... } finally { this.running = false; }`.
   - Docs chỉ mô tả cơ chế chống chồng lần chạy cho `@Cron` (`waitForCompletion`), không nói gì về `@Interval` [S8].
   - `@nestjs/locks` có `@WithoutOverlapping()` [S8], nhưng gói đó mới ở bản 0.0.4 [S68][S69].
2. Tìm bảng có thay đổi: `boards.last_seq > coalesce(max(snapshots.seq), 0)` và `deleted_at IS NULL`.
   - Một raw query `LEFT JOIN` / `GROUP BY` là đủ.
   - Hoặc thêm cột `boards.last_snapshot_seq` để query thành `findMany` thường.
   - Nhớ ép `max()` về `int` (bẫy BigInt, 2.3).
3. Với từng bảng, chụp **nhất quán** mà không chặn người vẽ: dùng `$transaction(async (tx) => { đọc board.lastSeq; đọc elements chưa xóa }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })` [S32]. Hoặc chụp trong `BoardLocks.run`, nhưng cách đó chặn bảng trong lúc đọc.
4. `snapshot.create({ boardId, seq, data: { formatVersion: 1, elements } })`. Dùng lại định dạng export của 7.2.
5. Một bảng lỗi thì log rồi chuyển sang bảng tiếp. Đừng để một bảng làm hỏng cả vòng.

### 8.2 Khôi phục: `POST /api/boards/:id/snapshots/:sid/restore`

1. Quyền `clearOrRestoreVersion`.
2. Trong `BoardLocks.run(boardId)`:
   1. Chụp một snapshot của trạng thái hiện tại, label `before-restore` (6.5).
   2. Trong một transaction (đặt `timeout` lớn hơn, ví dụ 30 s):
      - `updateMany` đánh dấu mọi element hiện có là đã xóa (`isDeleted: true`, `version` +1).
      - Với mỗi element trong snapshot: `upsert` theo `boardId_id` [S36], đặt `isDeleted: false` và `version` mới. Element vẫn giữ dòng, nên undo và tham chiếu không vỡ.
      - Ghi một op `restore_snapshot` với `seq = last_seq + 1` và payload `{ snapshotId }`. Cập nhật `last_seq`.
   3. Vẫn trong lock: `socketEmitter.toBoard(boardId, 'BoardReset', { seq })`. Client gọi lại `JoinBoard` không kèm `lastSeq`.

### 8.3 Dọn op cũ

- Một job `@Cron` hằng ngày: xóa `operations` có `seq <= (seq snapshot mới nhất)` **và** `created_at < now() − 30 ngày` (6.6).
- Không cần làm gì thêm cho `MissedOps`: kiểm tra khoảng hổng ở mục 4 tự chuyển sang `BoardState`.

**Test:**

- Bảng không đổi thì không có snapshot mới.
- Vẽ 1 op: lần chạy sau có đúng 1 snapshot.
- Gọi job hai lần chồng nhau (`Promise.all`): chỉ một lần chạy.
- Khôi phục: element thừa bị xóa mềm, element thiếu quay lại, phòng nhận `BoardReset`, có snapshot `before-restore`.
- Client nối lại qua op `restore_snapshot` thì nhận `BoardState`.

**Bẫy có thể xảy ra:**

1. **Chạy chồng.** Vòng trước chưa xong (nhiều bảng, DB chậm) thì vòng sau đã bắt đầu, và hai vòng chụp trùng.
2. **Nhiều instance.** "The scheduler runs every job in every process of your application" [S8].
   - Cách gọn: thêm `@@unique([boardId, seq])` cho `snapshots`. Instance thứ hai dính `P2002`, coi là "đã có" và bỏ qua. Job trở thành idempotent.
   - Cách khác: `@OnOneInstance()` của `@nestjs/locks` với kho khóa dùng chung [S8], hoặc advisory lock của Postgres [S41].
   - Advisory lock cấp session thì giữ tới khi tự nhả hoặc hết session, không theo transaction [S41]. Với connection pool của Prisma, lệnh khóa và lệnh nhả có thể rơi vào hai connection khác nhau. Dùng bản cấp transaction (nhả khi transaction kết thúc [S41]) trong một interactive transaction, nhưng khi đó lại dính timeout (2.3).
3. **Snapshot 50.000 element trong một dòng JSON** có thể nặng hàng chục MB. Đo trước. Khi restore, chia `upsert` thành lô và tăng `timeout`.
4. **Quên chụp `before-restore`** thì lỡ tay khôi phục nhầm là mất dữ liệu.

---

## 9. Comment + mention (GĐ5, ngắn)

File: `modules/comment/{comment.module, comment.controller, comment.service, dto/}`.

1. `POST /api/boards/:id/comments`:
   - Quyền `comment`. `body` tối đa N ký tự.
   - Gắn vào `elementId` **hoặc** `(x, y)` hữu hạn. `parentId` (nếu có) phải thuộc cùng bảng.
2. Mention:
   - Client gửi `mentions: string[]` (danh sách userId). Hoặc server tách token có định dạng cố định như `@[uuid]` trong `body`.
   - Server **giao** danh sách đó với thành viên của bảng: không báo cho người ngoài, không làm lộ ai có quyền.
3. Trong **một** transaction: tạo comment, rồi `createMany` notifications.
4. Sau khi commit:
   - `socketEmitter.toBoard(boardId, 'CommentAdded', comment)`.
   - Với mỗi người được nhắc: `server.to('user:' + id).emit('NotificationCreated', ...)` (room theo user [S23]).
5. Resolve: `PATCH` đặt `resolvedAt`, rồi phát `CommentUpdated`.

**Bẫy:**

- Tách `@displayName` bằng regex: tên trùng hoặc có dấu cách làm nhắc nhầm người.
- Emit **trước** khi commit: client tải lại comment sẽ không thấy nó.

---

## 10. Phần xuyên suốt

### 10.1 Exception filter: WS khác HTTP

- **HTTP:** filter global `@Catch(Prisma.PrismaClientKnownRequestError)` (đăng ký bằng `APP_FILTER`) đổi lỗi Prisma sang lỗi HTTP:
  - `P2002` thành `ConflictException` (409).
  - `P2025` ("depends on one or more records that were required but not found" [S34]) thành 404.
  - Lỗi lạ thì Nest trả 500 "Internal server error" [S11].
- **WS:** `useGlobalFilters()` **không** áp cho gateway [S2][S11]. Viết `WsAllExceptionsFilter extends BaseWsExceptionFilter`:
  - Truyền `super({ includeCause: false })` để không dội payload về client [S2][S18].
  - Đổi lỗi đã biết thành `WsException`. Log lỗi lạ.
  - Gắn bằng `@UseFilters(new WsAllExceptionsFilter())` trên class gateway [S2].
  - Muốn một filter dùng chung cho cả hai kiểu thì rẽ nhánh theo `host.getType()` (`'http' | 'ws' | 'rpc'`) và lấy client bằng `host.switchToWs().getClient()` [S10].
- Nhắc lại 3.8: filter phát sự kiện `exception`, không gọi ack. Handler cần ack thì tự `try/catch`.

### 10.2 Logging

- `private readonly logger = new Logger(BoardService.name)` trong từng service [S16].
- `ConsoleLogger` có option `json: true` cho log có cấu trúc. Ghi ra stdout và để nền tảng thu gom [S16].
- Log `opId`, `boardId`, `reason` và số op. **Không** log cả payload: nặng, và có thể chứa chữ người dùng viết.
- Op bị từ chối thì log ở mức `debug`. Lỗi lạ thì `error`.

### 10.3 Graceful shutdown

1. `app.enableShutdownHooks()`. Mặc định hook tắt [S9].
2. `BoardService` (hoặc module board) implement `beforeApplicationShutdown()`: `await boardLocks.drain()`. Hook async được chờ cho tới khi xong [S9].
3. `PrismaService.onModuleDestroy()` gọi `$disconnect()`.
4. **Windows:** Nest "has limited support for application shutdown hooks on Windows", và `SIGTERM` không chạy [S9]. Trên máy dev Windows, Ctrl+C có thể không chạy đủ các hook. Kiểm tra shutdown trong Docker hoặc Linux.

### 10.4 Rate limiting

- REST: `ThrottlerModule.forRoot([{ ttl: 60_000, limit: N }])`, `ttl` tính bằng ms [S13]. `ThrottlerGuard` global cho login, register, upload, tạo link.
- Chạy sau proxy thì bật `trust proxy` [S13]. Nếu không, mọi request có cùng IP là IP của proxy.
- Kho mặc định nằm trong bộ nhớ. Nhiều server thì cần storage Redis [S13].
- WS: token bucket ở 3.7.

### 10.5 Bảng giới hạn 8.3: đặt ở đâu

| Giới hạn | Cơ chế |
|---|---|
| Kích thước tin, ví dụ 100 KB | `@WebSocketGateway({ maxHttpBufferSize: 100_000 })` [S18][S21]. Vượt thì **socket bị đóng** [S21], xem bẫy 8 ở 2.3 |
| ≤ 100 op mỗi lô | `@ArrayMaxSize(100)` trong `SubmitOpsDto` |
| Type element trong allowlist | `@IsIn(ELEMENT_TYPES)` + `validateData` trong domain |
| ≤ 5.000 điểm, chữ ≤ 10.000, tên ≤ 50 | `validateData` / `validatePatchValue` (1.1). `@MaxLength(50)` cho `displayName` |
| Số hữu hạn | `Number.isFinite` trong domain. `@IsNumber()` cho field có kiểu cố định (mặc định chặn NaN và Infinity [S47]) |
| 30 `SubmitOps`/s, 30 cursor/s | Token bucket trong `socket.use` (3.7) |
| Upload 10 MB, chỉ ảnh | `limits.fileSize` + `FileTypeValidator` có magic number (5.1) |
| ≤ 50.000 element mỗi bảng | Kiểm tra số lượng trong `submitOps` khi có `add` (2.3 bước 5) và khi import (7.2) |

---

## Thứ tự code đề xuất

Theo cột "Cần từ giai đoạn" ở mục 4.1 của spec. Chưa qua bài "xong khi" thì chưa sang bước sau.

**GĐ1: MVP vẽ chung một bảng**

- [ ] `domain/permissions.ts` + spec. *Xong khi:* test 4 × 8 ô xanh.
- [ ] `domain/apply-op.ts` với `add` / `update` / `delete` / `clear` + spec (merge nông, NaN, `__proto__`, deleted). *Xong khi:* mọi case ở 1.1 xanh và không case nào mutate input.
- [ ] `board-locks.ts` + spec. *Xong khi:* 5 test ở 2.1 xanh, `size() === 0`.
- [ ] `BoardController` `POST /api/boards`, `BoardService.submitOps` (elements + `last_seq`, chưa có bảng `operations`). *Xong khi:* 20 lô song song cho `seq` liên tục và version đúng.
- [ ] `SocketEmitter`, gateway `JoinBoard` / `SubmitOps` / `handleDisconnect`, `PresenceTracker` + spec. *Xong khi:* e2e 2 client, A vẽ thì B nhận `OpsApplied`. F5 thấy lại nội dung. Mở 2 tab rồi đóng 1 tab: không có `UserLeft`.

**GĐ2: Công cụ vẽ + ảnh**

- [ ] `z-index.ts` (`fractional-indexing`) + `reorder`, `restore`, luật `locked`, `validateData` đủ mọi type. *Xong khi:* 1.000 lần "front" vẫn tăng ngặt. Sort trên Postgres đúng thứ tự byte (test có khóa `"Zz"` và `"a0"`).
- [ ] Asset upload / serve + `LocalDiskStorage`. *Xong khi:* 6 test e2e ở 5.4 xanh.

**GĐ3: Cộng tác thật sự**

- [ ] Bảng `operations`, dedupe `opId`, payload là op đã resolve, xử lý `P2002` ngoài transaction. *Xong khi:* gửi lại một lô 3 lần thì DB y như gửi 1 lần.
- [ ] `MissedOps` có ngưỡng và kiểm tra khoảng hổng. *Xong khi:* 4 test ở mục 4 xanh.
- [ ] Ephemeral relay, `TokenBucket` + spec, `socket.use`, `Ping`/`Pong`, khóa mềm ô chữ. *Xong khi:* client spam 200 cursor/s thì B nhận khoảng 30/s và server không lỗi. Spam kéo dài thì bị ngắt.
- [ ] `WsExceptionFilter` trên gateway (đổi `BadRequestException` thành `WsException`, như setup-guide bước 7.3), typed events. *Xong khi:* payload sai trả lỗi có nghĩa (không phải "Internal server error") và không dội payload về.

**GĐ4: Tài khoản, phân quyền, lịch sử**

- [ ] Auth REST (argon2, JWT, refresh xoay vòng), JWT trong `server.use`, Google OAuth. *Xong khi:* socket không token hoặc token sai nhận `connect_error`. Token hết hạn giữa chừng thì bị ngắt.
- [ ] Sharing: `resolveRole`, room `member:` / `share:`, `AccessChanged` + `disconnectSockets`. *Xong khi:* 3 test e2e ở 7.2 xanh.
- [ ] Snapshot job, restore + `BoardReset`, dọn op. *Xong khi:* 5 test ở mục 8 xanh.
- [ ] Graceful shutdown + throttler REST. *Xong khi:* `docker stop` trong lúc đang gửi op thì không mất op đã ack.

**GĐ5: Bình luận**

- [ ] Comment + mention + notification qua room `user:`. *Xong khi:* nhắc một người ngoài bảng thì không tạo notification. Người được nhắc đang online nhận `NotificationCreated`.

---

## Nguồn

**NestJS** (docs v12, đọc ngày 2026-10-24)

- [S1] Gateways: https://docs.nestjs.com/websockets/gateways
- [S2] WebSocket exception filters: https://docs.nestjs.com/websockets/exception-filters
- [S3] WebSocket pipes: https://docs.nestjs.com/websockets/pipes
- [S4] WebSocket guards: https://docs.nestjs.com/websockets/guards
- [S5] WebSocket adapter: https://docs.nestjs.com/websockets/adapter
- [S6] File upload: https://docs.nestjs.com/techniques/file-upload
- [S7] Streaming files: https://docs.nestjs.com/techniques/streaming-files
- [S8] Task scheduling: https://docs.nestjs.com/techniques/task-scheduling
- [S9] Lifecycle events: https://docs.nestjs.com/fundamentals/lifecycle-events
- [S10] Execution context: https://docs.nestjs.com/fundamentals/execution-context
- [S11] Exception filters: https://docs.nestjs.com/exception-filters
- [S12] Validation: https://docs.nestjs.com/techniques/validation
- [S13] Rate limiting: https://docs.nestjs.com/security/rate-limiting
- [S14] Passport recipe: https://docs.nestjs.com/recipes/passport
- [S15] Authentication (`@nestjs/authentication`): https://docs.nestjs.com/security/authentication
- [S16] Logger: https://docs.nestjs.com/techniques/logger
- [S17] Source `@nestjs/common@12.2.0`, `pipes/file/file-type.validator.js` + `package.json`: https://registry.npmjs.org/@nestjs/common/-/common-12.2.0.tgz
- [S18] Source `@nestjs/websockets@12.2.0`, `exceptions/base-ws-exception-filter.js`, `interfaces/gateway-metadata.interface.d.ts`: https://registry.npmjs.org/@nestjs/websockets/-/websockets-12.2.0.tgz
- [S19] Source `@nestjs/platform-express@12.2.0`, `multer/multer/multer.utils.js`: https://registry.npmjs.org/@nestjs/platform-express/-/platform-express-12.2.0.tgz

**Socket.IO**

- [S20] Server API: https://socket.io/docs/v4/server-api/
- [S21] Server options: https://socket.io/docs/v4/server-options/
- [S22] Middlewares: https://socket.io/docs/v4/middlewares/
- [S23] Rooms: https://socket.io/docs/v4/rooms/
- [S24] Emit cheatsheet: https://socket.io/docs/v4/emit-cheatsheet/
- [S25] TypeScript: https://socket.io/docs/v4/typescript/
- [S26] Connection state recovery: https://socket.io/docs/v4/connection-state-recovery
- [S27] Delivery guarantees: https://socket.io/docs/v4/delivery-guarantees
- [S28] Client API: https://socket.io/docs/v4/client-api/
- [S29] Client options: https://socket.io/docs/v4/client-options/
- [S30] How to use with JWT: https://socket.io/how-to/use-with-jwt
- [S31] Source `socket.io@4.8.4`, `dist/socket.js` (`_onerror`): https://registry.npmjs.org/socket.io/-/socket.io-4.8.4.tgz

**Prisma** (docs v7, trừ S39)

- [S32] Transactions (v7): https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions
- [S33] Prisma Client reference (v7), `transactionOptions`, `adapter`: https://www.prisma.io/docs/orm/v7/reference/prisma-client-reference
- [S34] Error reference (v7): https://www.prisma.io/docs/orm/v7/reference/error-reference
- [S35] Working with Json fields (v7): https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types/working-with-json-fields
- [S36] Composite IDs and constraints (v7): https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types/working-with-composite-ids-and-constraints
- [S37] CRUD (v7): https://www.prisma.io/docs/orm/v7/prisma-client/queries/crud
- [S38] Raw queries (v7): https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries
- [S39] Transactions (Prisma 8, docs hiện tại): https://www.prisma.io/docs/orm/prisma-client/queries/transactions

**PostgreSQL / SQLite**

- [S40] Collation: https://www.postgresql.org/docs/current/collation.html
- [S41] Explicit locking (row locks, advisory locks): https://www.postgresql.org/docs/current/explicit-locking.html
- [S42] Transactions tutorial (aborted state, savepoint): https://www.postgresql.org/docs/current/tutorial-transactions.html
- [S43] JSON functions (`jsonb ||`): https://www.postgresql.org/docs/current/functions-json.html
- [S44] SQLite datatypes (BINARY collation): https://www.sqlite.org/datatype3.html

**Validation**

- [S45] class-validator README: https://github.com/typestack/class-validator
- [S46] class-transformer README: https://github.com/typestack/class-transformer
- [S47] Source `class-validator@0.15.1`, `decorator/typechecker/IsNumber`: https://registry.npmjs.org/class-validator/-/class-validator-0.15.1.tgz
- [S48] Source `class-transformer@0.5.1`, `TransformOperationExecutor.js`: https://registry.npmjs.org/class-transformer/-/class-transformer-0.5.1.tgz

**Thuật toán**

- [S49] Evan Wallace (Figma), Realtime editing of ordered sequences: https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
- [S50] Evan Wallace (Figma), How Figma's multiplayer technology works: https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- [S51] `fractional-indexing` (README + `src/index.js` v4.0.0): https://github.com/rocicorp/fractional-indexing, tarball https://registry.npmjs.org/fractional-indexing/-/fractional-indexing-4.0.0.tgz
- [S52] David Greenspan, Implementing Fractional Indexing: https://observablehq.com/@dgreensp/implementing-fractional-indexing (README trỏ tới, chưa đọc trực tiếp)
- [S53] RFC 2697, A Single Rate Three Color Marker (token bucket): https://www.rfc-editor.org/rfc/rfc2697
- [S54] RFC 5905, NTPv4 (công thức offset theta): https://www.rfc-editor.org/rfc/rfc5905
- [S55] Douglas & Peucker (1973), Algorithms for the reduction of the number of points required to represent a digitized line or its caricature: https://doi.org/10.3138/FM57-6770-U75U-7727
- [S56] Ramer (1972), An iterative procedure for the polygonal approximation of plane curves: https://doi.org/10.1016/S0146-664X(72)80017-0

**Bảo mật**

- [S57] OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- [S58] OWASP File Upload Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- [S59] OWASP Prototype Pollution Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html
- [S60] MDN `Object.assign()`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign
- [S61] MDN `JSON.parse()`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse
- [S62] RFC 9700, OAuth 2.0 Security BCP, §4.14.2 refresh token rotation: https://www.rfc-editor.org/rfc/rfc9700

**Thư viện auth / upload**

- [S63] passport-jwt README: https://github.com/mikenicholson/passport-jwt
- [S64] passport-google-oauth20 README: https://github.com/jaredhanson/passport-google-oauth2
- [S65] multer README: https://github.com/expressjs/multer
- [S66] Source `argon2@0.45.1`, `argon2.d.cts` / `argon2.cjs`: https://registry.npmjs.org/argon2/-/argon2-0.45.1.tgz
- [S67] Node.js crypto (`randomBytes`, `randomUUID`, `timingSafeEqual`): https://nodejs.org/api/crypto.html. Hành vi kiểm tra bằng chạy thử trên Node v24.18.0
- [S68] npm registry, phiên bản `latest` và dist-tags: `https://registry.npmjs.org/<package>/latest`, `https://registry.npmjs.org/-/package/prisma/dist-tags`
- [S69] `@nestjs/locks`: https://www.npmjs.com/package/@nestjs/locks

RDP [S55][S56] chỉ liên quan tới server ở chỗ đặt trần số điểm. Rút gọn điểm là việc của client (8.2).

---

## Chưa xác minh

- **Prisma 7 hay 8.** Hướng dẫn giả định Prisma 7.10.x. Nếu setup-guide cài `prisma@latest` (8.0.0-rc.27) thì mọi chỗ `$transaction`, option `timeout` / `isolationLevel`, mã lỗi `P2002` đều phải viết lại theo [S39]. Mã lỗi mới của Prisma 8 cho unique violation chưa đọc tới (trang error reference của v8 quá dài, chưa đọc hết).
- **`meta.target` của P2002 khi dùng driver adapter** (bắt buộc từ Prisma 7 [S33]): docs không nói. Vì vậy hướng dẫn chỉ dựa vào `e.code`.
- **Prisma khai báo collation cột trong `schema.prisma`:** chưa tìm thấy trong docs v7. Hướng dẫn dùng SQL trong migration.
- **`createMany` / `upsert` với 50.000 dòng** (giới hạn số tham số của Postgres, Prisma có tự chia lô không): chưa kiểm chứng.
- **`disconnectSockets()` sau `emit('AccessChanged')`:** đã biết thứ tự gửi tin được bảo đảm [S27]. Việc gói ngắt tới client trước khi transport đóng hẳn thì chưa kiểm chứng.
- **Header `X-Content-Type-Options: nosniff`** khi serve ảnh: không có trong hai nguồn OWASP / Nest đã đọc. Khuyến nghị theo kinh nghiệm.
- **Google OAuth:** README không nói về `email_verified` hay PKCE [S64]. Cần đọc docs OpenID Connect của Google trước khi liên kết tài khoản theo email.
- **`socket.data` bị gán đè khi gọi `client.data = {...}`:** hướng dẫn gán nguyên object. Nếu sau này dùng adapter Redis + `fetchSockets`, kiểm tra lại `data` có được đồng bộ đúng không.
- **SQLite + nhiều bảng ghi đồng thời** (lỗi "database is locked" qua driver adapter): chưa kiểm chứng. Sớm chuyển sang Postgres thì tránh được.
- **`@nestjs/authentication` 0.1.1:** mới ra một tháng, chưa đánh giá độ ổn định. Recipe passport vẫn còn trong docs nhưng không rõ có bị đánh dấu "legacy" ở trang khác hay không.
- **Quyết định thiết kế (đã chốt 2026-10-24, spec đã cập nhật):**
  - Lô `SubmitOps` từ chối theo từng op (5.4, 2.6 của spec).
  - `clear` bỏ qua element `locked`, phải là op duy nhất trong lô (UC 1.7).
  - Undo `clear` = `restore { clearSeq }`, server đọc `deletedIds` trong payload của op `clear` (UC 1.7, 7.4).
  - Viewer không gửi `UpdateViewport` (bảng 8.1).
  - Khóa mềm ô chữ: trường `editingElementId` trong `UpdateSelection` (5.2, 7.3).
  - Thu hồi quyền: room `member:{boardId}:{userId}` / `share:{linkId}`, `AccessChanged` trước `disconnectSockets()` (8.2).
