// Phát SAU khi lời mời đã lưu. Listener gửi mail; SharingService không cần biết mail gửi thế nào.
export const BOARD_INVITATION_CREATED = 'board.invitation-created';

export interface BoardInvitationCreatedEvent {
  invitationId: string;
  email: string;
  boardTitle: string;
  inviterName: string;
  token: string; // token gốc để dựng link; DB chỉ có sha256 của nó
}
