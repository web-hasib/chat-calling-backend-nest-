import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function test() {
  const connectionString = process.env.DATABASE_URL;
  console.log('Connecting to:', connectionString);
  const pool = new Pool({
    connectionString,
    ssl: connectionString?.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter } as any);

  try {
    await prisma.$connect();
    console.log('Successfully connected to Neon DB!');
    const users = await prisma.user.findMany();
    console.log('Users in database:', users);
  } catch (err) {
    console.error('Error during test:', err);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

test();
