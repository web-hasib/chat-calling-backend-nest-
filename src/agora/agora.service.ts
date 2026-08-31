import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcTokenBuilder, RtcRole } from 'agora-token';

@Injectable()
export class AgoraService {
  private readonly appId: string;
  private readonly appCertificate: string;

  constructor(private readonly configService: ConfigService) {
    this.appId = (this.configService.get<string>('AGORA_APP_ID') || process.env.AGORA_APP_ID || '').trim().replace(/^["']|["']$/g, '');
    this.appCertificate = (this.configService.get<string>('AGORA_APP_CERTIFICATE') || process.env.AGORA_APP_CERTIFICATE || '').trim().replace(/^["']|["']$/g, '');
  }

  generateRtcToken(
    channelName: string,
    userAccount: string,
    role: 'publisher' | 'subscriber' = 'publisher',
    expireTimeInSeconds = 86400 // 24 hours
  ): { token: string; appId: string; channelName: string; userAccount: string; expiresAt: number } {
    if (!this.appId || !this.appCertificate) {
      throw new BadRequestException('Agora App ID or App Certificate is not configured on the server');
    }

    if (!channelName) {
      throw new BadRequestException('Channel name is required to generate RTC token');
    }

    const rtcRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expireTimeInSeconds;

    // Build token using user account string (UUID or username)
    const token = RtcTokenBuilder.buildTokenWithUserAccount(
      this.appId,
      this.appCertificate,
      channelName,
      userAccount || 'anonymous',
      rtcRole,
      expireTimeInSeconds,
      expireTimeInSeconds
    );

    if (!token) {
      throw new BadRequestException('Failed to generate Agora RTC token. Please check Agora App ID and Certificate validity.');
    }

    return {
      token,
      appId: this.appId,
      channelName,
      userAccount: userAccount || 'anonymous',
      expiresAt: privilegeExpiredTs,
    };
  }
}
