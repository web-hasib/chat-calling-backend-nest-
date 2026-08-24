import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AgoraService } from './agora.service';

@Controller('agora')
export class AgoraController {
  constructor(private readonly agoraService: AgoraService) {}

  @Get('token')
  getToken(
    @Query('channelName') channelName: string,
    @Query('userAccount') userAccount?: string,
    @Query('userId') userId?: string,
    @Query('role') role?: 'publisher' | 'subscriber'
  ) {
    const account = userAccount || userId || 'anonymous';
    return this.agoraService.generateRtcToken(
      channelName,
      account,
      role || 'publisher'
    );
  }
}
