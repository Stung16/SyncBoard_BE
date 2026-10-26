-- Tải bảng khi vào phòng chỉ đọc element chưa xóa (thiết kế 4.5). Prisma không khai báo được index có WHERE nên viết tay.
CREATE INDEX "elements_board_id_active_idx" ON "elements" ("board_id") WHERE "is_deleted" = false;
