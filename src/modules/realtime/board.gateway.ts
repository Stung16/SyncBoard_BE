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
import { submitOpsSchema, type SubmitOpsDto } from '../board/dto/op.dto.js';
import { BoardService } from '../board/services/board.service.js';
import type { JwtPayload } from '../auth/types/auth.types.js';
import { joinBoardSchema, type JoinBoardDto } from './dto/join-board.dto.js';
import { colorFor, listMembers, type Member } from './presence-tracker.js';

// client.data: userId gán lúc bắt tay (middleware); joined gán khi JoinBoard thành công. Có joined = đã vào bảng.
export type SocketData = { userId: string; joined?: { boardId: string; role: Role; member: Member } };
type Client = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
type Io = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const room = (boardId: string) => `board:${boardId}`;

@UseFilters(new WsExceptionFilter())
@WebSocketGateway({ maxHttpBufferSize: 100_000 }) // 100 KB (thiết kế 8.3); vượt quá thì socket bị đóng
export class BoardGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new Logger(BoardGateway.name);
  @WebSocketServer() private readonly server!: Io;

  constructor(
    private readonly emitter: SocketEmitter,
    private readonly jwt: JwtService,
    private readonly boards: BoardService,
  ) {}

  afterInit(server: Io) {
    this.emitter.bind(server); // từ đây module khác phát tin qua SocketEmitter
    // Cổng vào: chạy MỘT lần lúc bắt tay, trước mọi tin. Sai/thiếu token -> client nhận connect_error, không vào được.
    server.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
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

  @SubscribeMessage('JoinBoard')
  async joinBoard(@MessageBody({ schema: joinBoardSchema }) dto: JoinBoardDto, @ConnectedSocket() client: Client) {
    const { userId } = client.data;
    const role = await this.boards.resolveRole(dto.boardId, userId);
    if (!role) return { ok: false, reason: 'not_found' };

    const prev = client.data.joined;
    if (prev && prev.boardId !== dto.boardId) await this.leave(client); // một socket = một bảng

    // Vào room TRƯỚC rồi mới đọc: op commit sau lúc đọc chắc chắn tới qua OpsApplied (không lỡ).
    // Op commit trước lúc đọc mà OpsApplied tới sau thì bị trùng -> client bỏ qua OpsApplied có seq <= seq đang có.
    await client.join(room(dto.boardId));
    // Nối lại (có lastSeq): chỉ gửi phần lỡ. Vào lần đầu, hoặc không phát lại được -> gửi cả bảng.
    const missed = dto.lastSeq === undefined ? null : await this.boards.getMissedOps(dto.boardId, dto.lastSeq);
    const state = missed ? null : await this.boards.getState(dto.boardId);

    const member: Member = { userId, clientId: dto.clientId, displayName: dto.displayName, color: colorFor(userId) };
    client.data.joined = { boardId: dto.boardId, role, member };

    const members = await this.membersIn(dto.boardId);
    // Chỉ báo khi đây là tab ĐẦU TIÊN của người này (tab thứ 2 không phải "người mới vào").
    // shortcut: 2 tab vào cùng lúc trên 2 node có thể đều thấy tab kia -> không ai báo UserJoined. Hiếm; chấp nhận.
    if (members.filter((m) => m.userId === userId).length === 1) client.to(room(dto.boardId)).emit('UserJoined', member);
    const users = listMembers(members);
    if (state) client.emit('BoardState', { ...state, users });
    else client.emit('MissedOps', { ops: missed, users });
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
      const { applied, rejected, duplicates } = await this.boards.submitOps(joined.boardId, userId, dto.ops); // service phát OpsApplied
      for (const r of rejected) client.emit('OpRejected', r); // chỉ người gửi
      return {
        ok: true,
        applied: applied.map(({ opId, seq }) => ({ opId, seq })),
        rejected: rejected.map(({ opId, reason }) => ({ opId, reason })),
        duplicates, // đã lưu từ lần gửi trước: client coi như đã xác nhận, không phát lại cho ai
      };
    } catch (e) {
      if (e instanceof AppError && e.code === 'BOARD_NOT_FOUND') return { ok: false, reason: 'not_found' };
      this.logger.error(e);
      return { ok: false, reason: 'internal' };
    }
  }

  // Lúc này socket đã tự rời mọi room, nên membersIn không đếm nó nữa.
  async handleDisconnect(client: Client) {
    const joined = client.data.joined;
    if (!joined) return;
    try {
      await this.announceLeftIfLastTab(joined.boardId, joined.member.userId);
    } catch (e) {
      this.logger.warn(`UserLeft not sent: ${String(e)}`); // fetchSockets có thể timeout khi một node treo
    }
  }

  private async leave(client: Client) {
    const { boardId, member } = client.data.joined!;
    client.data.joined = undefined;
    await client.leave(room(boardId));
    await this.announceLeftIfLastTab(boardId, member.userId);
  }

  private async announceLeftIfLastTab(boardId: string, userId: string) {
    const others = await this.membersIn(boardId);
    if (!others.some((m) => m.userId === userId)) this.server.to(room(boardId)).emit('UserLeft', { userId });
  }

  // Socket trong room trên MỌI node (Redis adapter hỏi các node khác), đọc phần đã join.
  private async membersIn(boardId: string): Promise<Member[]> {
    const sockets = await this.server.in(room(boardId)).fetchSockets();
    return sockets.flatMap((s) => (s.data.joined ? [s.data.joined.member] : []));
  }
}
