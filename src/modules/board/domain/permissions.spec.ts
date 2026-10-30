import type { BoardRole } from '../../../generated/prisma/enums.js';
import { type Action, can, type Role } from './permissions.js';

// Chép tay từ bảng 8.1 của spec, ĐỘC LẬP với MATRIX. Hai bản lệch nhau = test đỏ.
const EXPECTED: Record<Role, Record<Action, boolean>> = {
  OWNER: {
    view: true,
    sendPresence: true,
    comment: true,
    submitOps: true,
    clearOrRestoreVersion: true,
    lockElement: true,
    manageSharing: true,
    renameOrDeleteBoard: true,
  },
  EDITOR: {
    view: true,
    sendPresence: true,
    comment: true,
    submitOps: true,
    clearOrRestoreVersion: true,
    lockElement: true,
    manageSharing: false,
    renameOrDeleteBoard: false,
  },
  COMMENTER: {
    view: true,
    sendPresence: true,
    comment: true,
    submitOps: false,
    clearOrRestoreVersion: false,
    lockElement: false,
    manageSharing: false,
    renameOrDeleteBoard: false,
  },
  VIEWER: {
    view: true,
    sendPresence: false,
    comment: false,
    submitOps: false,
    clearOrRestoreVersion: false,
    lockElement: false,
    manageSharing: false,
    renameOrDeleteBoard: false,
  },
};

// Trải bảng 4x8 thành 32 dòng [role, action, kỳ vọng] -> mỗi ô là một test riêng, đỏ ô nào thấy ngay ô đó.
const cases = Object.entries(EXPECTED).flatMap(([role, actions]) =>
  Object.entries(actions).map(([action, allowed]) => [role, action, allowed] as const),
);

describe('can (bảng quyền 8.1)', () => {
  it('đủ 4 vai trò x 8 hành động', () => expect(cases).toHaveLength(32));

  it.each(cases)('%s + %s -> %s', (role, action, allowed) => {
    expect(can(role as Role, action as Action)).toBe(allowed);
  });

  it('Role trùng enum BoardRole của Prisma (DB thêm vai trò mà quên ở đây -> tsc đỏ)', () => {
    expectTypeOf<BoardRole>().toEqualTypeOf<Role>();
  });
});
