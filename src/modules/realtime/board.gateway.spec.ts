import { Test, TestingModule } from '@nestjs/testing';
import { SocketEmitter } from '../../infra/socket/socket-emitter.service.js';
import { BoardGateway } from './board.gateway.js';

describe('BoardGateway', () => {
  let gateway: BoardGateway;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BoardGateway, SocketEmitter],
    }).compile();

    gateway = module.get<BoardGateway>(BoardGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });
});
