import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }) });

// Bảng cố định để dev mở thẳng /b/<id> mà không phải tạo mới.
const DEMO_BOARD_ID = '0192f000-0000-7000-8000-000000000001';

async function main() {
  await prisma.board.upsert({
    where: { id: DEMO_BOARD_ID },
    update: {},
    create: {
      id: DEMO_BOARD_ID,
      title: 'Demo board',
      elements: {
        create: [
          {
            id: 'el_rect_1',
            type: 'rect',
            data: { x: 100, y: 100, width: 200, height: 120, strokeColor: '#1e1e1e' },
            zIndex: 'a0',
            updatedBy: 'seed',
          },
          {
            id: 'el_sticky_1',
            type: 'sticky',
            data: { x: 400, y: 120, width: 180, height: 180, text: 'Xin chào', color: '#fff3a0' },
            zIndex: 'a1',
            updatedBy: 'seed',
          },
        ],
      },
    },
  });
  console.log(`Seeded board ${DEMO_BOARD_ID}`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
