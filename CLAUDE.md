# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Setup done: config, full DB schema (16 tables incl. auth/sessions/invitations/audit), Prisma migrations, Redis + Socket.IO sharded Redis adapter (multi-node), health check (DB + Redis), gateway shell with Zod validation, e2e harness incl. a two-node test. Business logic files (`board-locks.ts`, `domain/*`, `presence-tracker.ts`) are intentionally empty — the user writes them; their specs hold `it.todo` cases. Documents are written in Vietnamese; keep that language when editing them.

## Commands

```bash
docker compose up -d                 # Postgres 18 on :5433 (5432 is taken by a native install; creates syncboard + syncboard_test) + Redis 8 on :6379. App and e2e both need them
npm run start:dev                    # app on :3000, GET /health
npx tsc --noEmit && npm run lint     # tsc also checks test/, prisma/seed.ts (nest build doesn't)
npm test                             # unit (Vitest, *.spec.ts next to source)
npm run test:e2e                     # e2e (test/*.e2e-spec.ts); runs `migrate deploy` on TEST_DATABASE_URL first
npx vitest run path/to/file.spec.ts -t "test name"   # single file / single test
npx prisma migrate dev --name <x> && npx prisma generate   # Prisma 7: migrate dev does NOT generate or seed
npx prisma db seed                   # demo board 0192f000-0000-7000-8000-000000000001
```

ESM: relative imports need the `.js` suffix. Global pipe/adapter/shutdown hooks live in `src/app.setup.ts` (`setupApp`, async — it connects the adapter's Redis clients) so `main.ts` and e2e tests share them; e2e must `await setupApp(app)` and `app.listen(0)` for the gateway to accept connections. `multer` is forced to 2.5.0 via `overrides` (platform-express 12.2.0 pins a vulnerable 2.4.0) — don't run `npm audit fix --force`, it downgrades Nest to 11.

- `SyncBoard — Phân tích thiết kế.md` — the design spec (data model, event protocol, use cases per feature level 1–8, concurrency, permissions). Source of truth for behavior.
- `docs/research/nestjs-folder-structure.md` — researched folder structure with cited sources; the tree in section 4 is the one to follow.
- `docs/research/setup-guide.md` — verified scaffolding steps, pinned versions, commands (incl. running a single test).
- `docs/research/implementation-guide.md` — per-module logic, library APIs, pitfalls, build order with "xong khi" checks.

The user codes the project themselves from these guides: explain and review rather than writing whole modules unless asked.

## Stack

NestJS 12 (ESM, scaffolded by `nest new`: Vitest + oxlint + Prettier, npm, Node 24 LTS), Socket.IO 4.8, Prisma **7.10.1 pinned exactly** with `@prisma/adapter-pg` (npm `latest` for `prisma` is a Prisma 8 RC with a different transaction/error API — never upgrade implicitly), PostgreSQL 18 via `compose.yaml`, `@nestjs/schedule`, `@nestjs/passport` + `@nestjs/jwt`, Zod 4 (`zod@4.6.7` pinned) for all validation — env via `ConfigModule` `validationSchema`, REST/WS via the built-in global `StandardSchemaValidationPipe` with `@Body({ schema })` / `@MessageBody({ schema })`, types via `z.infer`, no DTO classes and no `class-validator`/`class-transformer`; HTTP stays Express, `fractional-indexing` for z-index, `argon2` for passwords. Prisma config file is `prisma7.config.ts`. Not .NET — the design was migrated from ASP.NET/SignalR; don't reintroduce those terms.

## Architecture (big picture)

- **Operations, not board state.** Every persistent change is an op (`add`/`update`/`delete`/`restore`/`reorder`/`clear`) sent through one Socket.IO event, `SubmitOps`. Ephemeral events (cursor, selection, viewport, laser, emote) are relayed with `client.to(room)` and never touch the DB.
- **Server is the arbiter.** Per op: check membership/role (from `client.data`, never from client-sent `boardId`) → assign `seq`, bump element `version` → write `elements` + `operations` in one `prisma.$transaction` → broadcast `OpsApplied` to the whole room including sender.
- **Multi-node (chosen scaling model): N app instances + Socket.IO sharded Redis adapter** (`infra/socket/socket-io.adapter.ts`, `subscriptionMode: 'dynamic'`). Consequences for any code:
  - `server.to(room).emit`, `fetchSockets`, `disconnectSockets` already work across nodes (proved by `test/multi-node.e2e-spec.ts`). Code outside the gateway emits via `SocketEmitter` (`infra/socket`, global leaf module, bound in `BoardGateway.afterInit`).
  - Do **not** add `@socket.io/redis-emitter`: it publishes with plain `PUBLISH` and is silently ignored by the sharded adapter (verified). A future separate worker process must hand events to a realtime node (queue) instead of emitting directly.
  - In-memory state is per node only. `seq` must be allocated by the DB inside the transaction (`UPDATE boards SET last_seq = last_seq + n ... RETURNING`, the row lock serializes the board across nodes); `BoardLocks` is only a per-node optimization, never the source of correctness. Presence, soft text locks and job locks go in Redis (`REDIS` client from `infra/redis`), not in a `Map`.
  - Per-socket state (`client.data`, token bucket) can stay local: a socket lives on one node.
  - Redis adapter does not support Socket.IO connection state recovery; reconnect uses our own `lastSeq`/`MissedOps`.
  - Load balancer must use sticky sessions, or clients must use `transports: ['websocket']`.
- **Conflicts:** field-level LWW using `baseVersion` + partial `patch`; rejected ops get `OpRejected`. Text editing uses a soft lock in presence. Undo = client sends an inverse op.
- **Idempotency/reconnect:** `opId` unique per board; client rejoins with `lastSeq` and gets `MissedOps` (or full `BoardState` if too many).
- **Elements:** one `elements` table, shared columns + type-specific `data` JSON, composite PK `(board_id, id)` with client-generated ids, soft delete.
- **Images** go through REST upload + storage, never over the socket; ops carry only `assetId`.

## Code layout rules (from the research doc)

- `src/{config,common,infra,modules}`. `infra/` = external systems only (`database/` Prisma, `redis/` shared client, `socket/` adapter + emitter, later `storage/`), no business logic. `modules/` = one folder + one `*.module.ts` per feature, singular kebab-case names.
- `modules/board/domain/` holds pure TypeScript (LWW apply, z-index, permission matrix) with no NestJS/Prisma imports — that's where the hard logic and its unit tests live.
- Gateway lives in `modules/realtime/` and only receives/returns messages, delegating to services.
- Dependencies flow one way: gateway/controller → service → `infra/`. No module imports the gateway; anything that must emit or disconnect sockets uses `SocketEmitter` (`infra/socket`, a leaf module bound by the gateway in `afterInit`). `forwardRef` means the rule was broken.
- No repository layer, use cases, or interfaces unless there are already ≥ 2 implementations (currently only storage). DTOs live in each feature's `dto/`. Promote code to `common/` only once ≥ 2 modules use it.
- All providers stay singleton (no `Scope.REQUEST`). Unit specs sit next to the file; e2e specs in `test/`.
