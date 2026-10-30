// Trùng giá trị với enum BoardRole của Prisma -> truyền thẳng member.role vào can(), không cần đổi.
// domain/ không import Prisma: hàm thuần, test không cần DB.
export type Role = 'OWNER' | 'EDITOR' | 'COMMENTER' | 'VIEWER';

// Mỗi dòng của bảng 8.1 trong spec là một Action.
export type Action =
  | 'view' // xem bảng, thấy con trỏ người khác
  | 'sendPresence' // gửi con trỏ, viewport, emote, laser
  | 'comment'
  | 'submitOps' // vẽ, sửa, xóa
  | 'clearOrRestoreVersion' // xóa sạch bảng, khôi phục phiên bản
  | 'lockElement'
  | 'manageSharing' // mời người, đổi vai trò, tạo/thu hồi link
  | 'renameOrDeleteBoard';

// Chép đúng bảng 8.1 của spec. Đổi quyền = sửa MỘT chỗ này (test sẽ đỏ để nhắc cập nhật spec).
const EDITOR_ACTIONS: Action[] = [
  'view',
  'sendPresence',
  'comment',
  'submitOps',
  'clearOrRestoreVersion',
  'lockElement',
];

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  OWNER: new Set<Action>([...EDITOR_ACTIONS, 'manageSharing', 'renameOrDeleteBoard']),
  EDITOR: new Set<Action>(EDITOR_ACTIONS),
  COMMENTER: new Set<Action>(['view', 'sendPresence', 'comment']),
  VIEWER: new Set<Action>(['view']),
};

export const can = (role: Role, action: Action): boolean => MATRIX[role].has(action);
