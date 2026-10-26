import { UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WsExceptionFilter } from '../../common/filters/ws-exception.filter.js';
import { SocketEmitter } from '../../infra/socket/socket-emitter.service.js';
import { joinBoardSchema, type JoinBoardDto } from './dto/join-board.dto.js';

@UseFilters(new WsExceptionFilter())
@WebSocketGateway({ maxHttpBufferSize: 100_000 }) // 100 KB (thiết kế 8.3); vượt quá thì socket bị đóng
export class BoardGateway implements OnGatewayInit, OnGatewayDisconnect {
  // TODO(bạn code): inject BoardService, PresenceTracker
  constructor(private readonly emitter: SocketEmitter) {}

  afterInit(server: Server) {
    this.emitter.bind(server); // từ đây module khác phát tin qua SocketEmitter
    // TODO(bạn code, GĐ4): server.use(authMiddleware) kiểm JWT lúc bắt tay (implementation-guide 6.2)
  }

  handleDisconnect(_client: Socket) {
    // TODO(bạn code): presence.leave(client.id), gửi UserLeft (UC 1.4)
  }

  @SubscribeMessage('JoinBoard')
  async joinBoard(@MessageBody({ schema: joinBoardSchema }) dto: JoinBoardDto, @ConnectedSocket() client: Socket) {
    // TODO(bạn code): kiểm tra bảng tồn tại, presence, BoardState / MissedOps (UC 1.4, 7.5)
    await client.join(`board:${dto.boardId}`);
    return { ok: true }; // giá trị trả về = ack cho client
  }
}
