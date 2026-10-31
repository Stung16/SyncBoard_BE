import { Logger, UseFilters } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import { AppError } from '../../common/errors/app-error.js';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter.js';
import { SocketEmitter } from '../../infra/socket/socket-emitter.service.js';
import { can, type Role } from '../board/domain/permissions.js';
import { submitOpsSchema, type OpDto, type SubmitOpsDto } from '../board/dto/op.dto.js';
import { BoardService } from '../board/services/board.service.js';
import { SharingService } from '../board/services/sharing.service.js';
import type { JwtPayload } from '../auth/types/auth.types.js';
import { joinBoardSchema, type JoinBoardDto } from './dto/join-board.dto.js';
import {
  cursorSchema,
  ephemeralSchema,
  pingSchema,
  selectionSchema,
  viewportSchema,
  type CursorDto,
  type EphemeralDto,
  type PingDto,
  type SelectionDto,
  type ViewportDto,
} from './dto/presence.dto.js';
import { colorFor, listMembers, type Member } from './presence-tracker.js';
import { createSocketLimiter } from './token-bucket.js';

// Phần của socket khi đã vào bảng. selection/editing nằm ở đây để người vào sau (qua fetchSockets) biết ai đang chọn/sửa gì.
// accessRoom: member:{boardId}:{userId} hoặc share:{linkId} -> chủ bảng đổi quyền/thu hồi link thì SharingService đá đúng room này.
type Joined = { boardId: string; role: Role; accessRoom: string; member: Member; selection: string[]; editing: string | null };
// client.data: userId gán lúc bắt tay (middleware); joined gán khi JoinBoard thành công. Có joined = đã vào bảng.
export type SocketData = { userId: string; joined?: Joined };
type Client = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
type Io = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
type UpdateOp = Extract<OpDto, { type: 'update' }>;

const room = (boardId: string) => `board:${boardId}`;
// Danh tính gắn vào tin chuyển tiếp: server tự gắn từ client.data, KHÔNG lấy từ payload (client không giả làm người khác được)
const who = (j: Joined) => ({ userId: j.member.userId, clientId: j.member.clientId });
const selectionOf = (j: Joined) => ({ ...who(j), elementIds: j.selection, editingElementId: j.editing });

@UseFilters(new WsExceptionFilter())
@WebSocketGateway({ maxHttpBufferSize: 100_000 }) // 100 KB (thiết kế 8.3); vượt quá thì socket bị đóng
export class BoardGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new Logger(BoardGateway.name);
  @WebSocketServer() private readonly server!: Io;

  constructor(
    private readonly emitter: SocketEmitter,
    private readonly jwt: JwtService,
    private readonly boards: BoardService,
    private readonly sharing: SharingService,
  ) {}

  afterInit(server: Io) {
    this.emitter.bind(server); // từ đây module khác phát tin qua SocketEmitter
    // Cổng vào: chạy MỘT lần lúc bắt tay, trước mọi tin. Sai/thiếu token -> client nhận connect_error, không vào được.
    server.use((socket, next) => {
      void this.authenticate(socket).then(
        () => {
          this.limitRate(socket);
          next();
        },
        () => next(new Error('unauthorized')),
      );
    });
  }

  // Client gửi io(url, { auth: { token } }). Không dùng header Authorization: trình duyệt không gửi header khi mở WebSocket.
  private async authenticate(socket: Client) {
    const token: unknown = socket.handshake.auth['token'];
    if (typeof token !== 'string') throw new Error('missing token');
    const { sub, exp } = await this.jwt.verifyAsync<JwtPayload & { exp: number }>(token, { algorithms: ['HS256'] });
    socket.data = { userId: sub };
    // Socket sống lâu hơn access token (15 phút) -> tới hạn thì báo rồi ngắt; client refresh token rồi kết nối lại.
    const timer = setTimeout(() => {
      socket.emit('AuthExpired');
      socket.disconnect(true);
    }, exp * 1000 - Date.now());
    socket.once('disconnect', () => clearTimeout(timer));
  }

  // Chạy cho MỌI tin tới, trước handler. Hết lượt thì không gọi next() = tin bị bỏ.
  // (Gọi next(err) thì Socket.IO phát sự kiện 'error' trên socket, không ai nghe -> Node ném lỗi.)
  private limitRate(socket: Client) {
    const limit = createSocketLimiter();
    socket.use(([event], next) => {
      const verdict = limit(String(event));
      if (verdict === 'ok') return next();
      if (verdict === 'kick') socket.disconnect(true);
    });
  }

  @SubscribeMessage('Ping')
  ping(@MessageBody({ schema: pingSchema }) { clientTime }: PingDto) {
    return { event: 'Pong', data: { clientTime, serverTime: Date.now() } }; // trả { event, data } = Nest phát sự kiện Pong
  }

  @SubscribeMessage('JoinBoard')
  async joinBoard(@MessageBody({ schema: joinBoardSchema }) dto: JoinBoardDto, @ConnectedSocket() client: Client) {
    const { userId } = client.data;
    const access = await this.sharing.resolveAccess(dto.boardId, userId, dto.shareToken);
    if (!access) return { ok: false, reason: 'not_found' }; // không có bảng hoặc không có quyền: trả như nhau
    const { role } = access;

    const prev = client.data.joined;
    if (prev && prev.boardId !== dto.boardId) await this.leave(client); // một socket = một bảng
    else if (prev && prev.accessRoom !== access.room) await client.leave(prev.accessRoom); // vào lại cùng bảng bằng quyền khác

    // Vào room TRƯỚC rồi mới đọc: op commit sau lúc đọc chắc chắn tới qua OpsApplied (không lỡ).
    // Op commit trước lúc đọc mà OpsApplied tới sau thì bị trùng -> client bỏ qua OpsApplied có seq <= seq đang có.
    await client.join([room(dto.boardId), access.room]);
    // Nối lại (có lastSeq): chỉ gửi phần lỡ. Vào lần đầu, hoặc không phát lại được -> gửi cả bảng.
    const missed = dto.lastSeq === undefined ? null : await this.boards.getMissedOps(dto.boardId, dto.lastSeq);
    const state = missed ? null : await this.boards.getState(dto.boardId);

    const member: Member = { userId, clientId: dto.clientId, displayName: dto.displayName, color: colorFor(userId) };
    client.data.joined = { boardId: dto.boardId, role, accessRoom: access.room, member, selection: [], editing: null };

    const inRoom = await this.joinedIn(dto.boardId);
    // Chỉ báo khi đây là tab ĐẦU TIÊN của người này (tab thứ 2 không phải "người mới vào").
    // shortcut: 2 tab vào cùng lúc trên 2 node có thể đều thấy tab kia -> không ai báo UserJoined. Hiếm; chấp nhận.
    if (inRoom.filter((j) => j.member.userId === userId).length === 1) client.to(room(dto.boardId)).emit('UserJoined', member);
    const users = listMembers(inRoom.map((j) => j.member));
    const selections = inRoom.filter((j) => j.selection.length > 0 || j.editing).map(selectionOf); // "ai đang chọn/sửa gì"
    if (state) client.emit('BoardState', { ...state, users, selections });
    else client.emit('MissedOps', { ops: missed, users, selections });
    return { ok: true, role };
  }

  @SubscribeMessage('SubmitOps')
  async submitOps(@MessageBody({ schema: submitOpsSchema }) dto: SubmitOpsDto, @ConnectedSocket() client: Client) {
    const { joined, userId } = client.data;
    // Client Socket.IO gửi lại tin đệm ngay khi nối lại -> SubmitOps có thể tới TRƯỚC JoinBoard
    if (!joined) return { ok: false, reason: 'not_joined' };
    if (!can(joined.role, 'submitOps')) return { ok: false, reason: 'forbidden' };

    // Lỗi phải thành ack: ném ra thì filter phát sự kiện 'exception', emitWithAck của client chờ tới hết timeout.
    try {
      // Khóa mềm (7.3): op sửa chữ của ô người khác đang gõ -> từ chối riêng op đó
      const locked = await this.textLockedOps(joined.boardId, client.id, dto.ops);
      const ops = dto.ops.filter((o) => !locked.has(o.opId));
      const result = ops.length
        ? await this.boards.submitOps(joined.boardId, userId, ops) // service phát OpsApplied
        : { applied: [], rejected: [], duplicates: [] };
      const rejected = [...[...locked].map((opId) => ({ opId, reason: 'being_edited' as const })), ...result.rejected];

      for (const r of rejected) client.emit('OpRejected', r); // chỉ người gửi
      return {
        ok: true,
        applied: result.applied.map(({ opId, seq }) => ({ opId, seq })),
        rejected: rejected.map(({ opId, reason }) => ({ opId, reason })),
        duplicates: result.duplicates, // đã lưu từ lần gửi trước: client coi như đã xác nhận, không phát lại cho ai
      };
    } catch (e) {
      if (e instanceof AppError && e.code === 'BOARD_NOT_FOUND') return { ok: false, reason: 'not_found' };
      if (e instanceof AppError && e.code === 'SHUTTING_DOWN') return { ok: false, reason: 'shutting_down' }; // node đang tắt: gửi lại sau khi nối lại
      this.logger.error(e);
      return { ok: false, reason: 'internal' };
    }
  }

  // --- Sự kiện tạm: chỉ chuyển tiếp cho người khác (client.to = cả phòng TRỪ người gửi), không chạm DB ---

  @SubscribeMessage('UpdateCursor')
  updateCursor(@MessageBody({ schema: cursorSchema }) dto: CursorDto, @ConnectedSocket() client: Client) {
    const j = this.presenceOf(client);
    // volatile: người nhận đang nghẽn thì bỏ luôn tin này; tin sau đè lên nên mất vài tin không sao
    if (j) client.to(room(j.boardId)).volatile.emit('CursorMoved', { ...who(j), ...dto });
  }

  @SubscribeMessage('UpdateViewport')
  updateViewport(@MessageBody({ schema: viewportSchema }) dto: ViewportDto, @ConnectedSocket() client: Client) {
    const j = this.presenceOf(client);
    if (j) client.to(room(j.boardId)).volatile.emit('ViewportChanged', { ...who(j), ...dto });
  }

  @SubscribeMessage('SendEphemeral')
  sendEphemeral(@MessageBody({ schema: ephemeralSchema }) dto: EphemeralDto, @ConnectedSocket() client: Client) {
    const j = this.presenceOf(client);
    if (j) client.to(room(j.boardId)).emit('Ephemeral', { ...who(j), ...dto });
  }

  // Ack: { ok: true } hoặc { ok: false, reason: 'being_edited', by } khi xin sửa ô chữ người khác đang sửa.
  @SubscribeMessage('UpdateSelection')
  async updateSelection(@MessageBody({ schema: selectionSchema }) dto: SelectionDto, @ConnectedSocket() client: Client) {
    const j = this.presenceOf(client);
    if (!j) return { ok: false, reason: 'not_joined' };
    const editing = dto.editingElementId ?? null;
    if (editing && editing !== j.editing) {
      // shortcut: kiểm-rồi-gán không nguyên tử: 2 người bấm cùng ô chữ ĐÚNG cùng lúc trên 2 node có thể cùng được sửa
      // (khi đó chữ quay về LWW như chưa khóa). Cần chặt hơn thì dùng Redis SET NX.
      const holder = (await this.joinedIn(j.boardId)).find((o) => o.socketId !== client.id && o.editing === editing);
      if (holder) return { ok: false, reason: 'being_edited', by: holder.member.userId };
    }
    j.selection = dto.elementIds;
    j.editing = editing;
    client.to(room(j.boardId)).emit('SelectionChanged', selectionOf(j)); // không volatile: mất tin này thì viền chọn/khóa sai mãi
    return { ok: true };
  }

  // Lúc này socket đã tự rời mọi room, nên joinedIn không đếm nó nữa.
  async handleDisconnect(client: Client) {
    const joined = client.data.joined;
    if (!joined) return;
    try {
      await this.announceGone(joined);
    } catch (e) {
      this.logger.warn(`UserLeft not sent: ${String(e)}`); // fetchSockets có thể timeout khi một node treo
    }
  }

  private async leave(client: Client) {
    const joined = client.data.joined!;
    client.data.joined = undefined;
    await client.leave(room(joined.boardId));
    await client.leave(joined.accessRoom);
    await this.announceGone(joined);
  }

  // Một tab rời bảng: xóa viền chọn + nhả khóa mềm của tab đó; tab cuối của người này thì báo UserLeft.
  private async announceGone(j: Joined) {
    const r = room(j.boardId);
    if (j.selection.length > 0 || j.editing) this.server.to(r).emit('SelectionChanged', { ...who(j), elementIds: [], editingElementId: null });
    const others = await this.joinedIn(j.boardId);
    if (!others.some((o) => o.member.userId === j.member.userId)) this.server.to(r).emit('UserLeft', { userId: j.member.userId });
  }

  // Đã vào bảng + vai trò được gửi con trỏ/laser (VIEWER thì không). Không đủ thì bỏ qua im lặng: tin tạm không cần báo lỗi.
  private presenceOf(client: Client) {
    const j = client.data.joined;
    return j && can(j.role, 'sendPresence') ? j : undefined;
  }

  private async textLockedOps(boardId: string, socketId: string, ops: OpDto[]) {
    const textOps = ops.filter((o): o is UpdateOp => o.type === 'update' && 'text' in o.patch);
    if (textOps.length === 0) return new Set<string>(); // đa số lô không sửa chữ -> khỏi hỏi các node
    const editedByOthers = new Set((await this.joinedIn(boardId)).filter((o) => o.socketId !== socketId).map((o) => o.editing));
    return new Set(textOps.filter((o) => editedByOthers.has(o.elementId)).map((o) => o.opId));
  }

  // Socket trong room trên MỌI node (Redis adapter hỏi các node khác), đọc phần đã join.
  private async joinedIn(boardId: string) {
    const sockets = await this.server.in(room(boardId)).fetchSockets();
    return sockets.flatMap((s) => (s.data.joined ? [{ socketId: s.id, ...s.data.joined }] : []));
  }
}
