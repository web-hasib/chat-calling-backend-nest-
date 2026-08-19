import { Module } from '@nestjs/common';
import { LiveGateway } from './live.gateway';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  providers: [LiveGateway],
})
export class LiveModule {}
