import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/types/auth.types.js';
import {
  acceptInvitationSchema,
  changeRoleSchema,
  createInvitationSchema,
  createShareLinkSchema,
  type AcceptInvitationDto,
  type ChangeRoleDto,
  type CreateInvitationDto,
  type CreateShareLinkDto,
} from '../dto/sharing.dto.js';
import { SharingService } from '../services/sharing.service.js';

const uuid = { schema: z.uuid() }; // id sai định dạng -> 400 trước khi chạm DB (cột uuid sẽ ném lỗi Prisma)

// Mọi route trên /boards/:boardId/... chỉ OWNER dùng được (8.1 "mời người, đổi vai trò, tạo/thu hồi link"); service kiểm.
@Controller()
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  @Get('boards/:boardId/members')
  listMembers(@Param('boardId', uuid) boardId: string, @CurrentUser() user: AuthUser) {
    return this.sharing.listMembers(boardId, user.id);
  }

  @Patch('boards/:boardId/members/:userId')
  changeRole(
    @Param('boardId', uuid) boardId: string,
    @Param('userId', uuid) userId: string,
    @Body({ schema: changeRoleSchema }) dto: ChangeRoleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sharing.changeRole(boardId, user.id, userId, dto);
  }

  @Delete('boards/:boardId/members/:userId')
  @HttpCode(204)
  removeMember(@Param('boardId', uuid) boardId: string, @Param('userId', uuid) userId: string, @CurrentUser() user: AuthUser) {
    return this.sharing.removeMember(boardId, user.id, userId);
  }

  @Post('boards/:boardId/share-links')
  createLink(@Param('boardId', uuid) boardId: string, @Body({ schema: createShareLinkSchema }) dto: CreateShareLinkDto, @CurrentUser() user: AuthUser) {
    return this.sharing.createLink(boardId, user.id, dto);
  }

  @Get('boards/:boardId/share-links')
  listLinks(@Param('boardId', uuid) boardId: string, @CurrentUser() user: AuthUser) {
    return this.sharing.listLinks(boardId, user.id);
  }

  @Delete('boards/:boardId/share-links/:linkId')
  @HttpCode(204)
  revokeLink(@Param('boardId', uuid) boardId: string, @Param('linkId', uuid) linkId: string, @CurrentUser() user: AuthUser) {
    return this.sharing.revokeLink(boardId, user.id, linkId);
  }

  @Post('boards/:boardId/invitations')
  invite(@Param('boardId', uuid) boardId: string, @Body({ schema: createInvitationSchema }) dto: CreateInvitationDto, @CurrentUser() user: AuthUser) {
    return this.sharing.invite(boardId, user.id, dto);
  }

  @Get('boards/:boardId/invitations')
  listInvitations(@Param('boardId', uuid) boardId: string, @CurrentUser() user: AuthUser) {
    return this.sharing.listInvitations(boardId, user.id);
  }

  @Delete('boards/:boardId/invitations/:invitationId')
  @HttpCode(204)
  revokeInvitation(@Param('boardId', uuid) boardId: string, @Param('invitationId', uuid) invitationId: string, @CurrentUser() user: AuthUser) {
    return this.sharing.revokeInvitation(boardId, user.id, invitationId);
  }

  // Người được mời bấm link trong mail -> frontend gọi route này (cần đăng nhập đúng email được mời).
  @Post('invitations/accept')
  @HttpCode(200)
  accept(@Body({ schema: acceptInvitationSchema }) { token }: AcceptInvitationDto, @CurrentUser() user: AuthUser) {
    return this.sharing.acceptInvitation(user.id, token);
  }
}
