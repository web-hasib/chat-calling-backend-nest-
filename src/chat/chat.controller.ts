import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  Inject,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';
import type { StorageProvider } from '../storage/storage-provider.interface';


@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private chatService: ChatService,
    private prisma: PrismaService,
    @Inject('StorageProvider') private storageProvider: StorageProvider
  ) {}

  @Get('users')
  async getUsers(@Req() req, @Query('search') search?: string) {
    const userId = req.user.id;
    
    const whereClause: any = {
      id: { not: userId },
    };

    if (search) {
      const queryLower = search.trim();
      whereClause.OR = [
        { username: { contains: queryLower, mode: 'insensitive' } },
        { name: { contains: queryLower, mode: 'insensitive' } },
        { email: { contains: queryLower, mode: 'insensitive' } },
      ];
    }

    return this.prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        avatarUrl: true,
      },
    });
  }

  @Get('conversations')
  async getConversations(@Req() req) {
    return this.chatService.getConversations(req.user.id);
  }

  @Post('conversation')
  async createConversation(@Req() req, @Body() body: { recipientId: string }) {
    return this.chatService.getOrCreateConversation(req.user.id, body.recipientId);
  }

  @Get('conversation/:id/messages')
  async getMessages(
    @Req() req,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    return this.chatService.getMessages(id, req.user.id, cursor, limit ? parseInt(limit, 10) : 20);
  }

  @Post('conversation/:id/read')
  async markAsRead(@Req() req, @Param('id') id: string) {
    return this.chatService.markAsRead(id, req.user.id);
  }

  @Post('message/:id/reaction')
  async toggleReaction(@Req() req, @Param('id') id: string, @Body() body: { emoji: string }) {
    return this.chatService.toggleReaction(id, req.user.id, body.emoji);
  }

  @Delete('message/:id')
  async deleteMessage(
    @Req() req,
    @Param('id') id: string,
    @Query('mode') mode?: 'me' | 'everyone'
  ) {
    if (mode === 'everyone') {
      return this.chatService.deleteMessageForEveryone(id, req.user.id);
    } else {
      return this.chatService.deleteMessageForMe(id, req.user.id);
    }
  }

  @Patch('conversation/:id/settings')
  async updateSettings(
    @Req() req,
    @Param('id') id: string,
    @Body()
    body: {
      themeColor?: string;
      themeGradient?: string;
      bgImage?: string;
      defaultEmoji?: string;
      nicknameTargetUserId?: string;
      nickname?: string;
    }
  ) {
    return this.chatService.updateConversationSettings(id, req.user.id, body);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    const fileUrl = await this.storageProvider.uploadFile(file);
    return {
      fileUrl,
      fileType: file.mimetype.split('/')[0].toUpperCase(), // IMAGE, VIDEO, APPLICATION etc.
      fileName: file.originalname,
    };
  }

  @Post('group')
  async createGroup(
    @Req() req,
    @Body() body: { name: string; avatarUrl: string; participantIds: string[] }
  ) {
    return this.chatService.createGroupConversation(
      req.user.id,
      body.name,
      body.avatarUrl || '',
      body.participantIds || []
    );
  }

  @Post('group/join/:inviteCode')
  async joinGroupByInvite(@Req() req, @Param('inviteCode') inviteCode: string) {
    return this.chatService.joinGroupByInviteCode(inviteCode, req.user.id);
  }

  @Post('conversation/:id/leave')
  async leaveGroup(@Req() req, @Param('id') id: string) {
    return this.chatService.leaveGroup(id, req.user.id);
  }

  @Patch('group/:id/settings')
  async updateGroupSettings(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { name?: string; avatarUrl?: string }
  ) {
    return this.chatService.updateGroupSettings(id, req.user.id, body.name, body.avatarUrl);
  }

  @Patch('group/:id/role')
  async updateRole(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { targetUserId: string; role: string }
  ) {
    return this.chatService.updateParticipantRole(id, req.user.id, body.targetUserId, body.role);
  }

  @Post('group/:id/members')
  async addMembers(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { targetUserIds: string[] }
  ) {
    return this.chatService.addMembers(id, req.user.id, body.targetUserIds);
  }

  @Delete('group/:id/member/:targetUserId')
  async removeMember(
    @Req() req,
    @Param('id') id: string,
    @Param('targetUserId') targetUserId: string
  ) {
    return this.chatService.removeMember(id, req.user.id, targetUserId);
  }

  @Delete('group/:id')
  async deleteGroup(@Req() req, @Param('id') id: string) {
    return this.chatService.deleteGroup(id, req.user.id);
  }
}
