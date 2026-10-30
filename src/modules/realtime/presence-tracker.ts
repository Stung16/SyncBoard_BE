// Ai đang online KHÔNG lưu ở đâu cả: gateway hỏi Socket.IO "socket nào đang ở room này" (fetchSockets, chạy qua
// mọi node bằng Redis adapter) rồi đọc socket.data. Node chết thì socket của nó tự biến mất, không còn dữ liệu rác.
// File này chỉ giữ phần thuần: màu và gom nhiều tab về một người.

export type Member = { userId: string; clientId: string; displayName: string; color: string };

const PALETTE = ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#e8590c', '#5c940d'];

// Tính từ userId: mọi tab/thiết bị của một người cùng màu, không cần lưu.
export function colorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

// Gom theo userId (đã xác thực bằng JWT), không theo clientId (client tự khai, giả mạo được).
export function listMembers(members: Member[]): Member[] {
  return [...new Map(members.map((m) => [m.userId, m])).values()];
}
