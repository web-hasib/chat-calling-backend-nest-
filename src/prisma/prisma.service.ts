import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private client: PrismaClient;

  // Expose models as direct properties for clean usage (this.prisma.user, etc.)
  get user() { return this.client.user; }
  get conversation() { return this.client.conversation; }
  get conversationParticipant() { return this.client.conversationParticipant; }
  get message() { return this.client.message; }
  get messageReaction() { return this.client.messageReaction; }
  get callLog() { return this.client.callLog; }

  constructor() {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : undefined,
    });
    const adapter = new PrismaPg(pool);
    this.client = new PrismaClient({ adapter } as any);
  }

  async onModuleInit() {
    await this.client.$connect();
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
