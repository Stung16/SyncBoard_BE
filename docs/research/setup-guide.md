# Hướng dẫn tự dựng backend SyncBoard (giai đoạn 1)

Ngày khảo sát: 2026-10-24. Máy: Windows 11, Git Bash + PowerShell.

Tài liệu này để bạn **tự gõ** từng bước. Mỗi bước có lệnh, đoạn cấu hình tối thiểu và phần "Bẫy thường gặp". Code chỉ là khung và những dòng khó nhớ của thư viện. Logic nghiệp vụ (LWW, z-index, BoardLocks…) bạn tự viết theo tài liệu thiết kế.

Cách kiểm chứng: mọi phiên bản lấy bằng `npm view` ngày 2026-10-24. Toàn bộ bước 2 → 9 đã chạy thử trên một project nháp (ngoài repo): `nest new` vào thư mục có sẵn git, Prisma init/migrate/seed, app khởi động, `/health` trả `ok`, socket kết nối và nhận lỗi validate, unit test + e2e test pass, `tsc`/lint sạch. Riêng Docker chưa chạy được (Docker Desktop đang tắt), xem mục **Chưa xác minh**. Ký hiệu `[Nx]` trỏ tới mục **Nguồn**.

Cây thư mục và quy tắc lấy từ [nestjs-folder-structure.md](nestjs-folder-structure.md) mục 4–5. Những chỗ hướng dẫn này buộc phải lệch so với cây đó được gom ở mục **12**.

---

## 0. Phiên bản đã ghim

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| Node.js | **24 LTS** (≥ 24.15, mới nhất 24.22.1) | Node 24 đã sang Maintenance LTS từ 2026-10-20. Node 26 thành Active LTS ngày 2026-10-28 [N20]. Generator của Nest CLI cần ≥ 24.15 [N1]. Đã chạy thử trên 24.18.0 |
| Package manager | **npm** | `nest new` mặc định npm khi không có prompt [N3]. Máy đang có npm 12.0.2 |
| `@nestjs/cli` / `@nestjs/schematics` | 12.0.10 | |
| `@nestjs/core`, `common`, `platform-express`, `websockets`, `platform-socket.io`, `testing` | 12.2.0 | |
| `@nestjs/config` | 12.0.1 | |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | **7.10.1** (ghim chính xác, `--save-exact`) | Tag `latest` của `prisma` đang là `8.0.0-rc.27` (bản pre-release, API khác hẳn). Phải ghi rõ phiên bản [N7][P1][P8] |
| `socket.io` (đi kèm `@nestjs/platform-socket.io`) / `socket.io-client` | 4.8.4 / 4.8.4 | `platform-socket.io` ghim cứng `socket.io` 4.8.4 |
| `class-validator` / `class-transformer` | 0.15.1 / 0.5.1 | |
| TypeScript | 6.0.3 (template ghi `^6.0.2`) | npm `latest` đã là 7.0.2. Đừng tự nâng |
| Vitest / Vite | 4.1.12 / 8.3.5 | npm `latest` của Vitest là 5.0.5. Giữ bản template |
| oxlint / Prettier | 1.89.0 / 3.9.10 | Template mới dùng oxlint, **không còn ESLint** |
| supertest | 7.3.1 | |
| tsx / dotenv | 4.23.15 / 18.0.9 | Dùng để chạy seed và để Prisma CLI đọc `.env` |
| PostgreSQL (Docker) | `postgres:18-alpine` (18.6) | 19 mới ở `19rc1`. Prisma 7 hỗ trợ tới 18 [P6][D1] |

---

## Bước 1. Chuẩn bị máy

1. **Node 24 LTS.** Cài từ nodejs.org (bản 24.x) rồi kiểm tra:
   ```bash
   node -v   # cần >= v24.15
   npm -v
   ```
2. **Nest CLI.** Docs cài global [N1][N2]:
   ```bash
   npm i -g @nestjs/cli@12
   nest --version   # 12.0.x
   ```
   Không muốn cài global thì dùng `npx @nestjs/cli@12 <lệnh>`.
3. **Docker Desktop.** Windows 11 Pro 23H2+ và WSL ≥ 2.1.5 (`wsl --version`). Nếu chưa có WSL thì chạy `wsl --install` trong PowerShell (admin), khởi động lại máy rồi cài Docker Desktop. Backend mặc định là WSL 2 [D2]. Kiểm tra:
   ```bash
   docker version          # phải có cả Client lẫn Server
   docker compose version
   ```

**Bẫy thường gặp**
- `docker version` chỉ in phần Client, báo lỗi `dockerDesktopLinuxEngine` → Docker Desktop chưa chạy. Service `com.docker.service` trên máy đang để Manual, nên phải mở Docker Desktop bằng tay.
- **Máy bạn đang có sẵn PostgreSQL 17 cài native** (service `postgresql-x64-17`, chạy Automatic, nghe cổng **5432**). Nếu container cũng map 5432 thì hoặc báo trùng cổng, hoặc app lặng lẽ kết nối nhầm vào bản native và báo sai mật khẩu. Hướng dẫn này map container ra **5433**.
- **npm 12 chặn install script của dependency** theo mặc định. Khi cài sẽ thấy `npm warn install-scripts … prisma@7.10.1 (preinstall…)`, `@prisma/engines (postinstall…)`, `esbuild (postinstall…)` [NPM1]. Trong bản chạy thử, Prisma và tsx vẫn chạy được mà không cần duyệt. Nếu sau này gặp lỗi thiếu engine/binary thì chạy `npm install-scripts approve prisma @prisma/engines esbuild` (lệnh này ghi khối `allowScripts` vào `package.json`), rồi `npm install` lại. Script của chính project (`postinstall` ở bước 6) vẫn chạy bình thường.
- `npm i -g @nestjs/cli` không ghi rõ major thì sau này có thể kéo về bản 13. Ghi `@12` cho chắc.

---

## Bước 2. `nest new` vào repo đang có sẵn

Repo hiện có `README.md`, `CLAUDE.md`, `docs/`, file thiết kế và `.git`. Đã thử: chạy `nest new … --directory .` thẳng vào đây sẽ **dừng ngay** với lỗi `A merge conflicted on path "/README.md"`, và không ghi file nào. File khác không bị đụng, chỉ `README.md` trùng tên với template.

1. Commit tài liệu trước (**commit 0**) để sau đó dễ xem diff:
   ```bash
   git add CLAUDE.md docs "SyncBoard — Phân tích thiết kế.md"
   git commit -m "docs: design + research"
   ```
2. Tạm đổi tên README, scaffold, rồi trả README về:
   ```bash
   mv README.md README.keep.md
   nest new syncboard-be --directory . --package-manager npm --no-observe
   mv -f README.keep.md README.md
   ```
   - CLI còn hỏi **"Which module system would you like to use?"**. Chọn **ESM** (mặc định, đi kèm Vitest). CJS thì đi kèm Jest [N1][N3].
   - `--no-observe` để bỏ qua câu hỏi cài `@nestjs/observe`. Câu này mặc định là **Yes** khi chạy có terminal [N4].
   - **Không** thêm `--skip-git`. CLI chỉ tạo `.gitignore` khi không skip git, vì `.gitignore` không publish được lên npm [N4]. Chạy `git init` trên repo đã có chỉ là "reinitialize", lịch sử commit vẫn giữ nguyên (đã thử).
3. File được sinh (đã kiểm tra): `.gitattributes` (`* text=auto eol=lf`), `.gitignore` (đã có sẵn `.env`), `.oxlintrc.json`, `.prettierrc`, `nest-cli.json`, `package.json` (`"type": "module"`), `tsconfig.json` (`module: nodenext`, `strict: true`), `tsconfig.build.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `src/{main,app.module,app.controller,app.service,app.controller.spec}.ts`, `test/app.e2e-spec.ts` [N3][N5].
4. Dọn file mẫu: **xóa** `src/app.controller.ts`, `src/app.service.ts`, `src/app.controller.spec.ts`, và bỏ hai class này khỏi `app.module.ts`. `test/app.e2e-spec.ts` giữ lại để viết lại ở bước 9. Không bắt buộc: xóa script `deploy` và devDependency `@nestjs/mau` (dịch vụ deploy trả phí của Nest).
5. Bật thêm vài cờ strict trong `tsconfig.json`, ngay dưới `"strictPropertyInitialization": false`:
   ```jsonc
   "noUncheckedIndexedAccess": true,   // arr[i] có kiểu T | undefined, hợp với mảng points/ops
   "noImplicitOverride": true,         // phải ghi `override` khi ghi đè (filter, adapter)
   "noImplicitReturns": true,
   "noFallthroughCasesInSwitch": true  // hợp với switch(op.type)
   ```
   Đã thử: client Prisma được sinh ra vẫn qua `tsc` với các cờ này.
6. Chạy thử: `npm run build && npm test`.

**Bẫy thường gặp**
- **ESM:** mọi import tương đối phải có đuôi `.js`, kể cả khi file nguồn là `.ts`, ví dụ `import { AppModule } from './app.module.js'`. Lệnh `nest g …` tự thêm đuôi này, còn khi gõ tay thì hay quên. `main.ts` dùng `await bootstrap()` ở top-level.
- **Đừng bật `exactOptionalPropertyTypes`.** Đã thử: `prisma7.config.ts` do Prisma sinh ra lỗi ngay (`url: string | undefined`).
- `strictPropertyInitialization: false` là cố ý: DTO của class-validator khai báo field không có giá trị khởi tạo.
- `nest build` vẫn ghi ra `dist/` dù có lỗi type (đã thấy `Found 1 error(s)` nhưng app vẫn chạy). Đọc kỹ output, hoặc chạy `npx tsc --noEmit` trước khi commit.
- `.gitattributes` ép LF. Git Bash có thể in cảnh báo `LF will be replaced by CRLF` với các file cũ. Cảnh báo này vô hại.

**Commit 1:** `chore: scaffold NestJS 12 (ESM, vitest, oxlint)`.

---

## Bước 3. Bộ khung thư mục

Git không theo dõi thư mục rỗng, nên **chỉ tạo thư mục khi có file đầu tiên bỏ vào**. Đừng dùng `.gitkeep` cho cả cây. Dùng CLI để giữ đúng cách đặt tên (quy tắc 1, mục 5 của tài liệu cấu trúc). **Tạo module trước**, rồi mới tới service/controller/gateway: CLI đăng ký file mới vào module gần nhất. Đã thử: nếu `modules/board/board.module.ts` chưa có, `nest g service modules/board` sẽ đăng ký service vào `AppModule`.

```bash
# GĐ1: tạo ngay
nest g module  infra/database/prisma --flat       # -> src/infra/database/prisma.module.ts (tự import vào AppModule)
nest g service infra/database/prisma --flat --no-spec
nest g module  modules/board                      # -> src/modules/board/board.module.ts
nest g controller modules/board                   # sửa @Controller('board') thành 'boards'
nest g service modules/board                      # KHÔNG dùng --flat ở đây (đã thử: --flat ghi ra src/modules/board.service.ts)
nest g module  modules/realtime
nest g gateway modules/realtime/board --flat      # -> src/modules/realtime/board.gateway.ts, đăng ký vào RealtimeModule
```

Các file tạo tay trong GĐ1 (theo cây ở mục 4):

| Đường dẫn | Nội dung |
|---|---|
| `src/config/env.validation.ts` | bước 4 |
| `src/common/filters/ws-exception.filter.ts` | bước 7 |
| `src/modules/board/board-locks.ts` (+ `.spec.ts`) | hàng đợi Promise theo từng bảng |
| `src/modules/board/domain/{apply-op,z-index,permissions}.ts` (+ `apply-op.spec.ts`) | TypeScript thuần |
| `src/modules/board/dto/`, `src/modules/realtime/dto/` | DTO class-validator |
| `src/modules/realtime/presence-tracker.ts` (+ `.spec.ts`) | |
| `prisma/schema.prisma`, `prisma/seed.ts`, `prisma7.config.ts` | bước 6 |
| `test/app.e2e-spec.ts`, `test/realtime.e2e-spec.ts` | bước 9 |

**Để sau:** `infra/storage/` + `modules/asset/` (GĐ2). `board/operation.service.ts` + model `Operation` (GĐ3). `infra/socket/socket-emitter.*` (khi module đầu tiên ngoài gateway cần phát tin, khoảng GĐ4). `modules/{sharing,snapshot,auth,user}` và `common/{decorators,guards}` (GĐ4). `modules/comment` (GĐ5). `infra/socket/redis-io.adapter.ts` (UC 8.4).

**Bẫy thường gặp**
- `nest g resource` sinh kèm `entities/` và CRUD mẫu. Với SyncBoard, dùng `g module/controller/service` riêng lẻ thì gọn hơn (CLI 12 không có cờ `--no-crud`, đã thử).
- `--flat` nghĩa là "không tạo thư mục con mang tên đó". Dùng cho `prisma` (nằm trong `infra/database/`) và `board.gateway` (nằm trong `realtime/`). Đừng dùng cho `modules/board`.
- Không tạo `index.ts` barrel (quy tắc 6).

---

## Bước 4. Config: `@nestjs/config` + validate

```bash
npm i @nestjs/config@12 class-validator class-transformer
```

`src/config/env.validation.ts` theo mẫu `validate()` trong docs [N6]:

```ts
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsString, Max, Min, validateSync } from 'class-validator';

export enum NodeEnv { Development = 'development', Production = 'production', Test = 'test' }

class EnvironmentVariables {
  @IsEnum(NodeEnv) NODE_ENV: NodeEnv = NodeEnv.Development;   // giá trị khởi tạo = mặc định
  @IsInt() @Min(0) @Max(65535) PORT: number = 3000;
  @IsString() @IsNotEmpty() DATABASE_URL: string;
  @IsString() @IsNotEmpty() CORS_ORIGIN: string;              // "http://localhost:5173,http://..."
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) throw new Error(errors.toString());
  return validated;
}
```

Trong `app.module.ts`:

```ts
imports: [ConfigModule.forRoot({ isGlobal: true, validate }), /* PrismaModule, BoardModule, RealtimeModule */]
```

`.env.example` (commit file này). `.env` thì copy từ đây và **không commit**:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL="postgresql://syncboard:syncboard@localhost:5433/syncboard?schema=public"
TEST_DATABASE_URL="postgresql://syncboard:syncboard@localhost:5433/syncboard_test?schema=public"
CORS_ORIGIN=http://localhost:5173
```

**Bẫy thường gặp**
- Mặc định `ConfigModule` đọc `.env` ở **thư mục bạn đứng khi chạy lệnh**. Biến đã có trong môi trường thật (shell, Vitest `test.env`) **thắng** giá trị trong `.env` [N6]. Bước 9 dựa vào chính điều này.
- **`.env` chỉ được nạp lúc `ConfigModule.forRoot()` chạy.** Đã thử: đọc `process.env.CORS_ORIGIN` bên trong decorator (ví dụ `@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN } })`) cho ra `undefined`. Với ESM, file gateway được đánh giá trước thân `app.module.ts`. Vì vậy bước 7 truyền CORS qua adapter.
- `isGlobal: true` chỉ bỏ được việc import `ConfigModule`. Bạn vẫn phải inject `ConfigService`.
- Chỉ dùng `@IsString()` thì chuỗi rỗng vẫn qua. Thêm `@IsNotEmpty()` cho biến bắt buộc.
- Đổi `.env` khi đang chạy `start:dev` thì phải restart, vì watch không theo dõi `.env`.

---

## Bước 5. PostgreSQL bằng Docker Compose

Docker khuyến nghị tên file `compose.yaml` [D3]. Tạo ở gốc repo:

```yaml
name: syncboard
services:
  db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: syncboard
      POSTGRES_PASSWORD: syncboard
      POSTGRES_DB: syncboard
    ports:
      - "5433:5432"                 # 5432 trên máy đã bị PostgreSQL native chiếm
    volumes:
      - pgdata:/var/lib/postgresql  # Postgres 18+: mount ở đây, KHÔNG phải .../data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  pgdata:
```

`docker/postgres/init.sql` (tạo database cho e2e):

```sql
CREATE DATABASE syncboard_test;
```

```bash
docker compose up -d
docker compose ps            # chờ cột STATUS hiện (healthy)
docker compose exec db psql -U syncboard -c '\l'   # thấy syncboard và syncboard_test
```

Connection string: `postgresql://syncboard:syncboard@localhost:5433/syncboard?schema=public` [P7].

**Bẫy thường gặp**
- **Postgres 18 đổi chỗ lưu dữ liệu**: `PGDATA` thành `/var/lib/postgresql/18/docker`, `VOLUME` thành `/var/lib/postgresql`. Nhiều hướng dẫn cũ mount `…/postgresql/data`. Làm vậy với image 18 thì dữ liệu rơi vào volume ẩn danh và **mất khi tạo lại container** [D1].
- Script trong `docker-entrypoint-initdb.d` **chỉ chạy khi volume còn trống** (lần khởi tạo đầu) [D1]. Sửa `init.sql` sau đó thì phải `docker compose down -v` (xóa sạch dữ liệu), hoặc tự chạy `CREATE DATABASE` bằng `psql`.
- Trong `compose.yaml`, `$$` là để escape. `$${POSTGRES_USER}` được giữ nguyên để shell trong container tự đọc biến.
- Đổi `POSTGRES_PASSWORD` sau khi volume đã có dữ liệu thì không có tác dụng, vì mật khẩu chỉ được đặt lúc khởi tạo [D1].
- `docker compose config` kiểm tra cú pháp mà không cần daemon (đã chạy, cú pháp hợp lệ).

**Commit 2:** `chore: env validation + postgres compose` (gồm `.env.example`, **không** gồm `.env`).

---

## Bước 6. Prisma ORM 7

### 6.1 Cài và init

```bash
npm i -D --save-exact prisma@7.10.1
npm i -D dotenv tsx
npm i --save-exact @prisma/client@7.10.1 @prisma/adapter-pg@7.10.1
npx prisma --version          # phải thấy prisma 7.10.1 và @prisma/client 7.10.1
npm ls prisma @prisma/client @prisma/adapter-pg   # cả ba đều 7.10.1
npx prisma init --datasource-provider postgresql --output ../src/generated/prisma --no-skills
```

Lệnh init sinh ra (đã thử với 7.10.1):
- `prisma/schema.prisma`: `generator client { provider = "prisma-client"  output = "../src/generated/prisma" }`, `datasource db { provider = "postgresql" }`. **Không có `url` trong schema.**
- **`prisma7.config.ts`** ở gốc repo. Tên này là đúng, xem bẫy bên dưới.
- `.env`. Nếu đã có `.env` thì sửa lại `DATABASE_URL` theo bước 4.
- Thêm dòng `/src/generated/prisma` vào `.gitignore`.

Thêm `seed` vào `prisma7.config.ts` [P5]:

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: process.env['DATABASE_URL'] },
});
```

### 6.2 Schema GĐ1

Chép `Board` và `Element` từ tài liệu thiết kế mục 4.1–4.2. `Operation` (mục 4.3) để tới GĐ3. Những dòng dễ sai:

```prisma
model Board {
  id       String    @id @default(uuid(7)) @db.Uuid
  // title, lastSeq @map("last_seq"), createdAt, updatedAt @updatedAt, deletedAt ...
  elements Element[]                 // BẮT BUỘC có quan hệ ngược, nếu không schema báo lỗi
  @@map("boards")
}

model Element {
  boardId String @map("board_id") @db.Uuid
  id      String                     // client sinh
  data    Json                       // PostgreSQL: jsonb
  // ...
  board   Board  @relation(fields: [boardId], references: [id])
  @@id([boardId, id])                // khóa chính ghép
  @@map("elements")
}
```

### 6.3 Migrate, generate, partial index

```bash
npx prisma migrate dev --name init      # tạo prisma/migrations/<ts>_init + áp vào DB
npx prisma generate                     # migrate dev KHÔNG tự generate ở Prisma 7
```

Partial index `elements (board_id) WHERE is_deleted = false` (mục 4.5). Làm đúng như tài liệu thiết kế:

```bash
npx prisma migrate dev --create-only --name elements_active_idx
# file mới chỉ có "-- This is an empty migration." -> thêm:
#   CREATE INDEX "elements_board_id_active_idx" ON "elements" ("board_id") WHERE "is_deleted" = false;
npx prisma migrate dev                  # áp migration vừa sửa
```

Đã thử trên 7.10.1: chạy `migrate dev --create-only` thêm một lần nữa sau đó vẫn ra migration rỗng, tức là Prisma **không** sinh `DROP INDEX` cho index viết tay này. Cách thứ hai là preview feature `partialIndexes`: `previewFeatures = ["partialIndexes"]` + `@@index([boardId], where: { isDeleted: false })` [P4]. **Chỉ chọn một trong hai cách.** Đã thử: đang có index viết tay mà bật thêm preview thì Prisma sinh `CREATE INDEX` thêm lần nữa.

`migrate dev` hay `migrate deploy`:
- `migrate dev`: chỉ dùng khi phát triển. Nó so schema với lịch sử migration, sinh migration mới và dùng **shadow database** (cần quyền `CREATE DATABASE`).
- `migrate deploy`: chỉ áp các migration đã commit, không sinh mới và không reset. Dùng cho test DB, CI, production.

### 6.4 PrismaService / PrismaModule (`src/infra/database/`)

Prisma 7 **bắt buộc có driver adapter** (hoặc Accelerate URL) khi tạo client [N7]:

```ts
// prisma.service.ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';   // client.js, có .js

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({ adapter: new PrismaPg({ connectionString: config.getOrThrow<string>('DATABASE_URL') }) });
  }
  async onModuleInit() { await this.$connect(); }       // sai URL thì app chết ngay lúc khởi động
  async onModuleDestroy() { await this.$disconnect(); } // đóng luôn pool của pg
}
```

```ts
// prisma.module.ts
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

Trong `main.ts`, gọi `app.enableShutdownHooks()` để `onModuleDestroy` chạy khi bấm Ctrl+C [N7][N8].

### 6.5 Seed (`prisma/seed.ts`)

Seed tạo `PrismaClient` riêng (không có Nest), cũng phải truyền adapter:

```ts
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
// upsert một Board cố định + vài Element; khóa ghép dùng: where: { boardId_id: { boardId, id } }
try { await main(); } finally { await prisma.$disconnect(); }
```

```bash
npx prisma db seed
```

### 6.6 Script `postinstall`

```bash
npm pkg set scripts.postinstall="prisma generate"
```

Clone mới hoặc CI chạy `npm install` là có client ngay (đã thử với npm 12: script của chính project vẫn chạy).

**Bẫy thường gặp**
- **`npm i prisma` (không ghi phiên bản) cài bản 8 RC, mà Prisma 8 đổi gần hết API** [P8]:
  - Không sinh `PrismaClient` nữa; package client là `@prisma/orm-postgres`.
  - `$transaction(...)` được thay bằng `db.transaction(async (tx) => …)`, và query bên trong đi qua `tx.orm`.
  - Chưa có các option `timeout`/`isolationLevel`/`maxWait`.
  - Mã lỗi `P2002`/`P2025` không còn; trùng unique thì xem `error.sqlState === '23505'`.
  - `generate` đổi thành `contract emit`, `migrate dev` đổi thành `db update`, `migrate deploy` đổi thành `db migrate`, và không còn `migrate reset`.

  Toàn bộ hướng dẫn này và `implementation-guide.md` viết theo API Prisma 7. Vì vậy ghim **cả ba** gói `prisma`, `@prisma/client`, `@prisma/adapter-pg` ở đúng `7.10.1` bằng `--save-exact`. `npx prisma` khi chưa cài local cũng tải về bản 8, nên luôn chạy sau khi đã `npm install`. Prisma 8 dự kiến GA trong 10/2026; tới lúc đó tag `latest` của `@prisma/client` cũng sẽ nhảy lên 8. Ở lại 7 (Prisma vẫn vá lỗi cho 7 thêm 18 tháng sau ngày 8 GA) cho tới khi docs NestJS chuyển sang 8 [P1].
- **Tên file config:** Prisma 7.10+ sinh `prisma7.config.ts` và ưu tiên tên này, sau đó tới `.config/prisma7.*`, cuối cùng mới tới `prisma.config.*` [P2][N7]. Trang reference của Prisma vẫn chỉ ghi `prisma.config.*` [P3]. Đây là chỗ hai nguồn lệch nhau, và release note mới là nguồn đúng. Cứ giữ `prisma7.config.ts`, đừng đổi tên theo cây trong tài liệu cấu trúc.
- **Prisma CLI không tự đọc `.env`.** File config phải có `import 'dotenv/config'` (init đã thêm sẵn) [P3].
- **Sửa schema xong mà không `prisma generate`** thì type cũ vẫn còn, IDE báo thiếu field.
- `prisma init` mặc định **cài "agent skills"** vào `.claude/skills/`, `.agents/skills/`, `.windsurf/skills/` và tạo `skills-lock.json` (đã thấy khi thử). Repo này có `CLAUDE.md`, nên thêm `--no-skills` để khỏi lẫn vào `.claude/`.
- Docs Prisma trên prisma.io giờ mặc định hiển thị **Prisma 8**. Tra cứu thì mở mục `/docs/orm/v7/...`.
- Client sinh ra là ESM (suy từ `"type": "module"`), import bằng `…/client.js`. Không cần `moduleFormat` [N7].
- **Json:** đọc ra kiểu `Prisma.JsonValue`, ghi vào kiểu `Prisma.InputJsonValue`. Với cột `Json?`, phân biệt `Prisma.DbNull` (NULL của SQL) với `Prisma.JsonNull` (giá trị JSON `null`). Prisma không kiểm tra cấu trúc bên trong, nên DTO phải validate `data` theo `type`.
- **Khóa ghép** `@@id([boardId, id])` tạo khóa `boardId_id` cho `findUnique`/`update`/`upsert`.
- Prisma 7 **bỏ seed tự động** trong `migrate dev`/`migrate reset`. Phải chạy `prisma db seed` tay [P5].
- Prisma 7 không còn `$on('beforeExit')`. Dùng lifecycle hook của Nest [N7].
- Dùng `$transaction(async (tx) => …)` thì mọi query bên trong phải gọi qua `tx`, gọi `this.prisma` là chạy ngoài transaction [N7].

**Commit 3:** `feat(db): prisma 7 + init migration` (gồm `prisma/`, `prisma7.config.ts`, `src/infra/database/`. **Không** gồm `src/generated/`).

---

## Bước 7. Socket.IO gateway

```bash
npm i @nestjs/websockets@12 @nestjs/platform-socket.io@12
npm i -D socket.io-client@4
```

Không cần cài `socket.io` riêng. `@nestjs/platform-socket.io` 12.2.0 đã ghim cứng `socket.io` 4.8.4, nên `import { Server, Socket } from 'socket.io'` vẫn chạy.

### 7.1 Adapter để đưa CORS từ config vào

Tạo `src/infra/socket/socket-io.adapter.ts`. Mẫu `RedisIoAdapter` trong docs cũng ghi đè đúng hàm này [N9]:

```ts
export class SocketIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext, private readonly corsOrigin: string[]) { super(app); }
  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.corsOrigin } } as ServerOptions);
  }
}
```

`as ServerOptions` là bắt buộc. Đã thử: không có nó thì TS báo `path: string | undefined`.

### 7.2 Gateway (`src/modules/realtime/board.gateway.ts`)

```ts
@UseFilters(new WsExceptionFilter())
@WebSocketGateway({ maxHttpBufferSize: 100_000 })   // 100 KB (mục 8.3); mặc định 1e6
export class BoardGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  constructor(/* private readonly boardService: BoardService, ... */) {}

  afterInit(server: Server) { /* sau này: socketEmitter.bind(server); server.use(authMiddleware) */ }
  handleConnection(client: Socket) { /* log */ }
  handleDisconnect(client: Socket) { /* presence.leave(client.id) */ }

  @SubscribeMessage('JoinBoard')
  async joinBoard(@MessageBody() dto: JoinBoardDto, @ConnectedSocket() client: Socket) {
    await client.join(dto.boardId);
    return { ok: true };            // giá trị trả về = ack cho client
  }
}
```

### 7.3 Filter WS (`src/common/filters/ws-exception.filter.ts`)

```ts
@Catch()
export class WsExceptionFilter extends BaseWsExceptionFilter {
  constructor() {
    super({ causeFactory: (pattern) => ({ pattern }) });   // không gửi lại payload trong `cause`
  }
  override catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof BadRequestException) exception = new WsException(exception.getResponse());
    super.catch(exception, host);
  }
}
```

Validate trên gateway có hai cách. Cả hai đã chạy thử:

| Cách | Làm gì | Client nhận khi `boardId: 'nope'` |
|---|---|---|
| **A (chọn)** | Một global `ValidationPipe` (bước 8) cho cả REST lẫn WS, cộng filter ở trên | `{ message: ["boardId must be a UUID"], error: "Bad Request", statusCode: 400 }` |
| B | **Không** có global pipe. Gateway dùng `@UsePipes(new ValidationPipe({ …, exceptionFactory: (e) => new WsException(e) }))` như docs [N10], còn REST gắn pipe riêng ở từng controller | mảng `ValidationError[]` (có cả `value` client đã gửi) |

Kết hợp global pipe **với** `@UsePipes(...exceptionFactory)` trên gateway mà không có filter thì **không chạy**. Đã thử: global pipe chạy trước, ném `BadRequestException`, nên client vẫn nhận `"Internal server error"`.

### 7.4 Gắn vào `main.ts`

```ts
const config = app.get(ConfigService);
app.useWebSocketAdapter(new SocketIoAdapter(app, config.getOrThrow<string>('CORS_ORIGIN').split(',')));
```

**Bẫy thường gặp**
- **Global `ValidationPipe` (bước 8) cũng chạy cho gateway** [N10]. Nó ném `BadRequestException`, và client chỉ nhận `{"status":"error","message":"Internal server error"}` (đã thử). Mẫu trong docs gắn `@UsePipes(new ValidationPipe({ exceptionFactory: e => new WsException(e) }))` lên gateway. Nhưng khi đã có global pipe, global pipe chạy **trước** và ném lỗi trước. Vì vậy dùng filter ở 7.3 để đổi `BadRequestException` thành `WsException`. Sau khi có filter, client nhận sự kiện `exception` có `message: ["boardId must be a UUID", …]` (đã thử).
- **Global exception filter không áp dụng cho gateway** [N11]. Phải gắn `@UseFilters()` ở class gateway.
- **`handleConnection` không phải là cổng chặn.** Nest không đợi nó chạy xong, nên tin nhắn đến sớm vẫn được xử lý. Kiểm tra auth khi kết nối thì dùng `server.use()` trong `afterInit`, kiểm tra từng tin thì dùng guard [N12].
- **CORS chỉ áp dụng cho long-polling, không áp dụng cho WebSocket** [S2]. Client dùng `transports: ['websocket']` thì CORS không chặn được gì. Đã thử với polling: origin hợp lệ nhận header `Access-Control-Allow-Origin`, origin lạ thì không có header.
- Tin vượt `maxHttpBufferSize` **làm đóng socket**, không sinh exception [S1]. Client sẽ thấy disconnect.
- Ném `WsException` với object thì Nest gửi nguyên object đó, không bọc thêm `status`/`cause` [N11]. Client cần xử lý cả hai dạng.
- **`includeCause` mặc định là `true`**: với lỗi dạng chuỗi và lỗi lạ (`Internal server error`), `BaseWsExceptionFilter` gửi kèm `cause: { pattern, data }`. Nghĩa là payload client gửi bị gửi ngược lại nguyên văn (đã thấy `cause.data = { boardId: "nope", … }`), có thể tới 100 KB mỗi lỗi. `causeFactory: (pattern) => ({ pattern })` chỉ giữ tên sự kiện. Hoặc dùng `includeCause: false` để bỏ hẳn [N11].
- Gateway chỉ được khởi tạo khi nằm trong `providers` của một module đã được import [N12].

**Commit 4:** `feat(realtime): board gateway + ws validation`.

---

## Bước 8. Global `ValidationPipe`

`main.ts` (đầy đủ phần khung):

```ts
const app = await NestFactory.create(AppModule);
const config = app.get(ConfigService);
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
app.useWebSocketAdapter(new SocketIoAdapter(app, config.getOrThrow<string>('CORS_ORIGIN').split(',')));
app.enableShutdownHooks();
await app.listen(config.get<number>('PORT') ?? 3000);
```

- `whitelist`: bỏ các field không có decorator. `forbidNonWhitelisted`: báo lỗi thay vì lặng lẽ bỏ. `transform`: biến payload thành instance DTO và đổi kiểu cho param/query [N10]. Đã thử: `dto instanceof JoinBoardDto === true` trong gateway.
- Để e2e chạy đúng cấu hình như production (mục 9), có thể tách ba dòng `useGlobalPipes`/`useWebSocketAdapter` ra một hàm `setupApp(app)` trong file riêng, ví dụ `src/app.setup.ts`. Không đặt hàm này trong `main.ts`, vì `main.ts` gọi `bootstrap()` ngay khi bị import.

**Bẫy thường gặp**
- DTO lồng nhau (ops chứa element) cần `@ValidateNested({ each: true })` **và** `@Type(() => ElementDto)` (của class-transformer). Thiếu `@Type` thì object con không được validate.
- `forbidNonWhitelisted` bắt mọi field lạ, kể cả field client gửi thừa. Field `data` có cấu trúc thay đổi theo `type`, nên phải tự validate riêng (mục 8.3).
- Trên Windows, `SIGTERM` **không bao giờ** tới được tiến trình. Ctrl+C (`SIGINT`) thì được [N8].

---

## Bước 9. Test

Runner là **Vitest** (template ESM). Unit spec đặt cạnh file, e2e nằm trong `test/` [N13].

### 9.1 Unit test

Thêm vào `vitest.config.ts`:

```ts
test: { globals: true, root: './', include: ['**/*.spec.ts'], setupFiles: ['reflect-metadata'] },
```

Ví dụ nên viết đầu tiên: `src/config/env.validation.spec.ts`, kiểm tra `PORT: '4000'` thành `4000`, và thiếu `DATABASE_URL` thì throw. Mock Prisma trong unit test bằng `{ provide: PrismaService, useValue: { board: { findUnique: vi.fn() } } }` [N7].

### 9.2 E2E với test DB

Cách làm: dùng một database riêng `syncboard_test` (bước 5). Trước khi chạy thì `migrate deploy` một lần, tắt chạy song song giữa các file, file nào ghi dữ liệu thì `TRUNCATE` trong `beforeEach`.

`vitest.config.e2e.ts`:

```ts
import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? '' },  // thắng .env
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
```

`test/global-setup.ts`:

```ts
import { execSync } from 'node:child_process';
export default function setup() {
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
}
```

Đã thử: cố ý để `DATABASE_URL` trong `.env` trỏ sai cổng, e2e vẫn pass. Nghĩa là `test.env` thắng `.env`, và test không bao giờ đụng vào DB dev.

`test/app.e2e-spec.ts` (REST, dùng supertest):

```ts
app = moduleRef.createNestApplication(); await app.init();
await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
```

`test/realtime.e2e-spec.ts` (socket.io-client), những dòng quan trọng:

```ts
app = moduleRef.createNestApplication();
// áp đúng pipe + adapter như main.ts (hoặc gọi setupApp(app))
await app.listen(0);                       // cổng ngẫu nhiên, gateway mới thật sự lắng nghe
const url = await app.getUrl();
client = io(url, { transports: ['websocket'], forceNew: true });
await new Promise<void>((ok, fail) => { client.once('connect', ok); client.once('connect_error', fail); });
const ack = await client.emitWithAck('JoinBoard', { boardId: '<uuid>' });
// lỗi validate: const err = new Promise(r => client.once('exception', r)); client.emit('JoinBoard', { boardId: 'x' });
// afterEach: client.disconnect();  afterAll: await app.close();
```

### 9.3 Chạy một file / một test

```bash
npx vitest run src/config/env.validation.spec.ts                 # một file unit
npx vitest run src/config/env.validation.spec.ts -t "throws when" # một test theo tên
npx vitest run --config ./vitest.config.e2e.ts test/realtime.e2e-spec.ts
npm test -- src/modules/board                                     # lọc theo đường dẫn qua script
```

**Bẫy thường gặp**
- **`Reflect.getMetadata is not a function`**: spec không import gì của `@nestjs/*`, nên không ai nạp `reflect-metadata`, mà class-transformer lại cần nó (đã gặp khi thử). `setupFiles: ['reflect-metadata']` sửa được lỗi này. Code trong `domain/` không dùng decorator nên không bị ảnh hưởng.
- Gọi `app.init()` thì gateway chưa nhận kết nối được, cần `app.listen(0)`.
- `createNestApplication()` **không** chạy `main.ts`. Pipe, adapter và filter toàn cục phải gắn lại trong test, nếu không test pass nhưng production chạy khác.
- Pattern `**/*.spec.ts` không khớp `*.e2e-spec.ts` (vì `-spec` khác `.spec`), nên `npm test` không chạy lẫn e2e.
- Nhớ `client.disconnect()` và `app.close()`, nếu không Vitest treo vì còn handle mở.
- Không dùng `prisma migrate reset` trong test tự động: lệnh này xóa sạch DB, và `--force` bỏ qua bước hỏi xác nhận.

**Commit 5:** `test: unit + e2e (rest, socket) with test db`.

---

## Bước 10. Lint, format, scripts, điểm commit

- **Lint: oxlint** (`.oxlintrc.json`: tắt `typescript/no-explicit-any`, bật `typescript/no-floating-promises` = error). `npm run lint` chạy `oxlint --type-aware src/ test/`. Thêm `--fix` để tự sửa.
- **Format: Prettier** (`singleQuote`, `trailingComma: all`). `npm run format`.
- Cả hai bỏ qua `src/generated/` vì thư mục này có trong `.gitignore` (đã thử). Không cần thêm `.prettierignore`.

| Script | Lệnh | Dùng khi |
|---|---|---|
| `start:dev` | `nest start --watch` | phát triển hằng ngày |
| `build` / `start:prod` | `nest build` / `node dist/main` | kiểm tra bản build |
| `test` / `test:watch` / `test:cov` | `vitest run` / `vitest` / `--coverage` | unit |
| `test:e2e` | `vitest run --config ./vitest.config.e2e.ts` | e2e (cần `docker compose up -d`) |
| `lint` / `format` | oxlint / prettier | trước khi commit |
| `postinstall` | `prisma generate` | tự chạy sau `npm install` |
| (gõ tay) | `npx prisma migrate dev --name <x>`, `npx prisma generate`, `npx prisma db seed`, `npx prisma studio` | |

**Điểm commit:** 0 (tài liệu) → 1 (scaffold, bước 2) → 2 (config + compose, bước 4–5) → 3 (Prisma + migration, bước 6) → 4 (gateway, bước 7–8) → 5 (test, bước 9). Mỗi lần commit: `npm run lint && npx tsc --noEmit && npm test` phải sạch. Sau commit 1, cập nhật mục "Project state" trong `CLAUDE.md` bằng các lệnh ở bảng trên, vì file đó đang ghi là chưa có lệnh build/test.

**Bẫy thường gặp**
- `npx tsc --noEmit` kiểm tra cả `test/`, `prisma/seed.ts`, `prisma7.config.ts`, còn `nest build` chỉ build `src/` (`tsconfig.build.json`). Lỗi type trong seed hay test chỉ hiện ở lệnh thứ nhất.
- `.env` đã có trong `.gitignore` của Nest. Kiểm tra `git status` trước commit 2 để chắc `.env` không lọt vào.
- `prisma/migrations/` **phải commit**. Còn `src/generated/` thì không.

---

## Bước 11. Checklist "xong setup khi…"

- [ ] `node -v` ≥ 24.15. `nest --version` ra 12.x. `docker version` có phần Server.
- [ ] `docker compose ps` thấy `db` ở trạng thái `(healthy)` trên cổng 5433. Có cả `syncboard` và `syncboard_test`.
- [ ] `npx prisma --version` ra `prisma 7.10.1` và `@prisma/client 7.10.1`.
- [ ] `npx prisma migrate status` báo `Database schema is up to date!`. Có migration `init` và `elements_active_idx`.
- [ ] `npx prisma db seed` chạy xong không lỗi.
- [ ] Xóa `DATABASE_URL` khỏi `.env` thì `npm run start:dev` **dừng ngay** với lỗi validate. Trả lại thì app khởi động.
- [ ] `curl localhost:3000/health` trả `{"status":"ok"}` (có chạy `SELECT 1` qua Prisma).
- [ ] Client socket.io kết nối được, `emitWithAck('JoinBoard', {boardId: <uuid>})` trả `{ ok: true }`. Gửi `boardId: 'x'` thì nhận sự kiện `exception` có thông báo validate, không phải `Internal server error`.
- [ ] `npm test` và `npm run test:e2e` pass, ít nhất có `env.validation.spec.ts`, `app.e2e-spec.ts`, `realtime.e2e-spec.ts`.
- [ ] `npm run lint` và `npx tsc --noEmit` sạch.
- [ ] `git status` không có `.env`, `src/generated/`, `dist/`, `.claude/skills/` của Prisma.

---

## 12. Những chỗ lệch so với `nestjs-folder-structure.md`

| Cây ở mục 4 ghi | Hướng dẫn này | Lý do |
|---|---|---|
| `prisma.config.ts` | `prisma7.config.ts` | Đúng tên mà Prisma 7.10.1 sinh ra. Chính tài liệu cấu trúc cũng dặn "giữ đúng tên mà `prisma init` sinh ra" [P2] |
| không có | `src/infra/socket/socket-io.adapter.ts` | Cần để đưa CORS từ `ConfigService` vào, vì decorator đọc env quá sớm. Sau này `redis-io.adapter.ts` có thể kế thừa hoặc thay file này |
| không có | `/health` | Checklist cần. Gọn nhất là một `modules/health/` nhỏ (module + controller chạy `SELECT 1`). Hoặc bỏ hẳn và kiểm tra bằng e2e |
| không có | `test/global-setup.ts`, `docker/postgres/init.sql`, `compose.yaml` | Hạ tầng cho test DB và Postgres |
| không có | `src/app.setup.ts` (không bắt buộc) | Để e2e dùng chung cấu hình pipe/adapter với `main.ts` |

---

## Nguồn

NestJS (docs đọc từ `nestjs/docs.nestjs.com` @ `952c9c5`, 2026-10-23):
- [N1] First steps (Node, `nest new`, ESM/Vitest, strict): https://docs.nestjs.com/first-steps · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/first-steps.md
- [N2] CLI overview: https://docs.nestjs.com/cli/overview · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/cli/overview.md
- [N3] Schematic `application` (template `ts-esm`, mặc định `type: esm`, `packageManager: npm`, prompt module system): https://github.com/nestjs/schematics/blob/a7e0f2d1a8b2161359c0eeede945c976faf60916/src/lib/application/application.factory.ts · https://github.com/nestjs/schematics/blob/a7e0f2d1a8b2161359c0eeede945c976faf60916/src/lib/application/schema.json · https://github.com/nestjs/schematics/tree/a7e0f2d1a8b2161359c0eeede945c976faf60916/src/lib/application/files/ts-esm
- [N4] `nest new` action (git init, `createGitIgnoreFile` chỉ khi không `--skip-git`, prompt observe): https://github.com/nestjs/nest-cli/blob/master/actions/new.action.ts (đọc trong gói npm `@nestjs/cli@12.0.10`, file `actions/new.action.js`)
- [N5] typescript-starter (`"type": "module"`, vitest, oxlint, TS ^6.0.2): https://github.com/nestjs/typescript-starter/blob/0b6d71261ba30bb6976949a8653e4a86479a68c1/package.json
- [N6] Configuration (validate, thứ tự ưu tiên env, isGlobal): https://docs.nestjs.com/application/configuration · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/application/configuration.md
- [N7] Prisma recipe (Prisma 7, cảnh báo tag `latest`, `prisma7.config.ts`, adapter bắt buộc, PrismaService, lifecycle, transaction, mock): https://docs.nestjs.com/recipes/prisma · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/data/prisma.md
- [N8] Lifecycle events (enableShutdownHooks, Windows không có SIGTERM): https://docs.nestjs.com/fundamentals/lifecycle-events · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/fundamentals/lifecycle-events.md
- [N9] WebSocket adapter (kế thừa `IoAdapter.createIOServer`): https://docs.nestjs.com/websockets/adapter · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/websockets/adapter.md
- [N10] Validation (whitelist/forbidNonWhitelisted/transform) và WS pipes (global pipe áp dụng cho gateway, chỉ `WsException` tới được client): https://docs.nestjs.com/application/validation · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/application/validation.md · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/websockets/pipes.md
- [N11] WS exception filters (global filter không áp dụng cho gateway, `BaseWsExceptionFilter`): https://docs.nestjs.com/websockets/exception-filters · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/websockets/exception-filters.md
- [N12] Gateways (lifecycle hook, `handleConnection` không phải cổng chặn, `server.use()`): https://docs.nestjs.com/websockets/gateways · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/websockets/gateways.md
- [N13] Testing (Vitest mặc định, e2e trong `test/`, `.e2e-spec`): https://docs.nestjs.com/fundamentals/testing · https://github.com/nestjs/docs.nestjs.com/blob/952c9c5af4592d33aa7f859fd772ce91dc30dfab/content/fundamentals/unit-testing.md
- [N20] Node.js release schedule: https://github.com/nodejs/Release/blob/main/schedule.json · danh sách bản phát hành: https://nodejs.org/dist/index.json

Prisma:
- [P1] Release status (8 là RC, GA dự kiến 10/2026, `latest` = 8.0.0-rc.27, cách ở lại Prisma 7): https://www.prisma.io/docs/orm/release-status
- [P2] Release 7.10.0 (`prisma7.config.ts`, thứ tự tìm file config, suy `moduleFormat`): https://github.com/prisma/orm/releases/tag/7.10.0 · 7.10.1: https://github.com/prisma/orm/releases/tag/7.10.1
- [P3] Prisma Config reference v7 (`prisma.config.*`, phải tự nạp `.env`, `migrations.seed`, `shadowDatabaseUrl`): https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference
- [P4] Indexes v7 (`partialIndexes` preview, `where`): https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes
- [P5] Seeding (cấu hình trong config, chỉ chạy khi gọi `prisma db seed`): https://www.prisma.io/docs/orm/prisma-migrate/workflows/seeding
- [P6] Supported databases v7 (PostgreSQL 9.6–18): https://www.prisma.io/docs/orm/v7/reference/supported-databases
- [P7] Connection URLs: https://www.prisma.io/docs/orm/reference/connection-urls
- [P8] Coming from Prisma ORM 7 (Prisma 8: `db.transaction`, không `PrismaClient`, đổi tên lệnh, bỏ mã lỗi P2xxx, chưa có timeout/isolationLevel): https://www.prisma.io/docs/orm/coming-from-prisma-orm-7

Socket.IO:
- [S1] Server options (`maxHttpBufferSize` mặc định 1e6, quá thì đóng socket; `cors`): https://socket.io/docs/v4/server-options/
- [S2] Handling CORS (bắt buộc từ v3, chỉ áp dụng cho HTTP long-polling): https://socket.io/docs/v4/handling-cors/
- [S3] Client API (`emitWithAck`): https://socket.io/docs/v4/client-api/

Docker:
- [D1] Image `postgres` (PGDATA/VOLUME đổi từ bản 18, initdb.d, POSTGRES_*): https://hub.docker.com/_/postgres · https://github.com/docker-library/docs/blob/master/postgres/content.md · tag (18.6, 19rc1): https://hub.docker.com/_/postgres/tags
- [D2] Docker Desktop cho Windows (WSL ≥ 2.1.5, Win11 23H2): https://docs.docker.com/desktop/setup/install/windows-install/
- [D3] Tên file Compose (`compose.yaml` được ưu tiên): https://docs.docker.com/compose/intro/compose-application-model/

npm:
- [NPM1] `npm install-scripts` (npm 12 chặn install script của dependency theo mặc định, `allowScripts`): https://docs.npmjs.com/cli/v12/commands/npm-install-scripts
- [NPM2] Phiên bản ở mục 0: `npm view <pkg> version` và `npm view <pkg> dist-tags` (registry.npmjs.org), chạy ngày 2026-10-24
- Vitest (lọc theo file và `-t`): https://vitest.dev/guide/filtering

---

## Chưa xác minh

- **Chưa chạy `docker compose up`.** Docker Desktop trên máy đang tắt, và hướng dẫn này không tự bật nó. `compose.yaml` mới chỉ qua `docker compose config` (đúng cú pháp). Đường dẫn volume của Postgres 18, việc `init.sql` chỉ chạy lần đầu và healthcheck đều lấy từ docs, chưa chạy thật.
- **Prisma migrate/seed/app được thử trên `npx prisma dev`** (Prisma Postgres local), không phải trên container Postgres 18. Trên `prisma dev` phải đặt `shadowDatabaseUrl` (cổng 51215), vì database duy nhất ở đó là `template1`. Với Docker thì không cần. Kết quả "migration tiếp theo không xóa partial index viết tay" mới thấy trên `prisma dev`.
- Không đọc được trang Prisma 7 nào nói rõ Prisma Migrate xử lý thế nào với index có trong DB mà không khai báo trong schema. Kết luận ở bước 6.3 chỉ dựa trên lần chạy thử.
- npm 12 chặn install script của `prisma`/`@prisma/engines`/`esbuild`, nhưng trong lần thử mọi thứ vẫn chạy. Chưa tìm hiểu vì sao: có thể binary đã nằm sẵn trong gói, cũng có thể được tải lúc chạy.
- Câu hỏi "Which module system…" khi chạy `nest new` có terminal: suy ra từ `x-prompt` trong `schema.json`. Lần thử chạy không có TTY nên tự lấy mặc định `esm`.
- Cờ `prisma init --no-skills`: lấy từ `prisma init --help` (7.10.1), chưa chạy thật với cờ này.
- Ctrl+C trên Windows có gọi `onModuleDestroy` hay không: theo docs [N8], chưa thử.
- Prisma 8 dự kiến GA trong 10/2026 [P1]. Nếu GA trước khi bạn làm, `@prisma/client@latest` cũng sẽ nhảy lên 8. Lệnh trong hướng dẫn đã ghi `@7` để tránh, nhưng docs NestJS có thể đổi ngay sau đó.
- TypeScript 7, Vitest 5, Node 26 chưa thử với Nest 12. Hướng dẫn giữ đúng phiên bản template.
- `@IsNotEmpty()` trong `env.validation.ts` chưa chạy thử (bản thử chỉ có `@IsString()`).
- `causeFactory: (pattern) => ({ pattern })` đã qua `tsc` và e2e (lỗi validate), nhưng chưa thử với lỗi lạ (`Internal server error`) để xem `cause.data` có thật sự biến mất không.
- `--save-exact` cho ba gói Prisma: chưa chạy thử. Bản thử dùng `prisma@7` / `@prisma/client@7`, cũng ra 7.10.1.
- Một số URL docs.nestjs.com chưa mở thử. `/application/configuration`, `/application/validation`, `/fundamentals/testing` lấy theo link nội bộ trong chính docs; `/recipes/prisma` là suy đoán. Nội dung đã đọc từ link GitHub đi kèm, được ghim theo commit.
