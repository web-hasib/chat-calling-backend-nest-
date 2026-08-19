import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ChatService } from './chat.service';

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000','https://231dpltn-3000.inc1.devtunnels.ms'],
    credentials: false,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Track active socket connections by User ID
  private activeUsers = new Map<string, string>(); // userId -> socketId

  // Track active group calls: conversationId -> { type, participants, startedAt, messages }
  private activeGroupCalls = new Map<string, { type: 'AUDIO' | 'VIDEO'; participants: Set<string>; startedAt: number; messages: any[] }>();
  private readonly MAX_GROUP_CALL_PARTICIPANTS: number;

  constructor(
    private jwtService: JwtService,
    private chatService: ChatService,
  ) {
    this.MAX_GROUP_CALL_PARTICIPANTS = parseInt(process.env.MAX_GROUP_CALL_PARTICIPANTS || '100', 10);
  }

  async handleConnection(client: Socket) {
    try {
      const authHeader = client.handshake.headers.authorization || client.handshake.auth?.token;
      if (!authHeader) {
        client.disconnect();
        return;
      }

      const token = authHeader.replace('Bearer ', '');
      const payload = this.jwtService.verify(token);
      const userId = payload.sub;

      client.data.userId = userId;
      this.activeUsers.set(userId, client.id);

      // Send list of currently online user IDs to the newly connected client
      client.emit('online-users-list', Array.from(this.activeUsers.keys()));

      // Broadcast user online status to all connected clients
      this.server.emit('user-status', { userId, status: 'online' });
    } catch (e) {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId;
    if (userId) {
      this.activeUsers.delete(userId);
      this.server.emit('user-status', { userId, status: 'offline' });

      // Cleanup group calls: remove user from any active group call and notify peers
      for (const [convoId, groupCall] of this.activeGroupCalls.entries()) {
        if (groupCall.participants.has(userId)) {
          groupCall.participants.delete(userId);

          // Notify remaining participants
          for (const peerId of groupCall.participants) {
            const peerSocketId = this.activeUsers.get(peerId);
            if (peerSocketId) {
              this.server.to(peerSocketId).emit('group-call-user-left', {
                userId,
                conversationId: convoId,
              });
            }
          }

          // If call is now empty or only 1 person left, end it completely
          if (groupCall.participants.size <= 1) {
            for (const lastPeerId of groupCall.participants) {
              const lastSocket = this.activeUsers.get(lastPeerId);
              if (lastSocket) {
                this.server.to(lastSocket).emit('group-call-ended', {
                  conversationId: convoId,
                });
              }
            }
            this.activeGroupCalls.delete(convoId);
          }

          // Broadcast updated call status to all participants in conversation
          this.broadcastGroupCallStatus(convoId);
        }
      }
    }
  }

  // --- Real-Time Chat Messaging ---

  @SubscribeMessage('send-message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; content?: string; fileUrl?: string; fileType?: string; replyToId?: string }
  ) {
    const senderId = client.data.userId;
    if (!senderId) return;

    const message = await this.chatService.createMessage(
      senderId,
      data.conversationId,
      data.content,
      data.fileUrl,
      data.fileType,
      data.replyToId
    );

    // Broadcast message to all subscribers of this conversation
    this.server.emit(`message-${data.conversationId}`, message);
    this.server.emit('new-message-notification', message);
  }

  @SubscribeMessage('mark-as-read')
  async handleMarkAsRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    const userId = client.data.userId;
    if (!userId || !data?.conversationId) return;

    const readInfo = await this.chatService.markAsRead(data.conversationId, userId);
    if (readInfo.count > 0) {
      this.server.emit(`messages-read-${data.conversationId}`, {
        conversationId: data.conversationId,
        readerId: userId,
        readAt: readInfo.readAt,
      });
      this.server.emit('conversation-read-update', {
        conversationId: data.conversationId,
        readerId: userId,
      });
    }
  }

  @SubscribeMessage('toggle-reaction')
  async handleToggleReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; messageId: string; emoji: string }
  ) {
    const userId = client.data.userId;
    if (!userId || !data?.messageId || !data?.emoji) return;

    const updatedReactions = await this.chatService.toggleReaction(data.messageId, userId, data.emoji);

    this.server.emit(`reaction-updated-${data.conversationId}`, {
      messageId: data.messageId,
      conversationId: data.conversationId,
      reactions: updatedReactions,
    });
  }

  @SubscribeMessage('delete-message')
  async handleDeleteMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: string; conversationId: string; mode?: 'me' | 'everyone' }
  ) {
    const userId = client.data.userId;
    if (!userId || !data?.messageId) return;

    if (data.mode === 'everyone') {
      const res = await this.chatService.deleteMessageForEveryone(data.messageId, userId);
      if (res) {
        this.server.emit(`message-deleted-everyone-${data.conversationId}`, {
          messageId: data.messageId,
          conversationId: data.conversationId,
        });
      }
    } else {
      const res = await this.chatService.deleteMessageForMe(data.messageId, userId);
      if (res) {
        client.emit(`message-deleted-me-${data.conversationId}`, {
          messageId: data.messageId,
          conversationId: data.conversationId,
        });
      }
    }
  }

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; isTyping: boolean; text?: string }
  ) {
    const userId = client.data.userId;
    if (!userId) return;
    this.server.emit(`typing-${data.conversationId}`, {
      userId,
      isTyping: data.isTyping,
      text: data.text || '',
    });
  }

  @SubscribeMessage('update-conversation-settings')
  async handleUpdateSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      conversationId: string;
      themeColor?: string;
      themeGradient?: string;
      bgImage?: string;
      defaultEmoji?: string;
      nicknameTargetUserId?: string;
      nickname?: string;
    }
  ) {
    const userId = client.data.userId;
    if (!userId || !data?.conversationId) return;

    const result = await this.chatService.updateConversationSettings(data.conversationId, userId, data);
    if (!result) return;

    this.server.emit(`conversation-updated-${data.conversationId}`, result);
    this.server.emit('conversation-list-updated', { conversationId: data.conversationId, conversation: result.conversation });

    if (result.systemMessage) {
      this.server.emit(`message-${data.conversationId}`, result.systemMessage);
      this.server.emit('new-message-notification', result.systemMessage);
    }
  }

  // --- WebRTC signaling events ---

  @SubscribeMessage('call-user')
  handleCallUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; offer: any; type: 'AUDIO' | 'VIDEO'; conversationId: string; callerName?: string; callerAvatar?: string }
  ) {
    const fromUserId = client.data.userId;
    const receiverSocketId = this.activeUsers.get(data.to);

    if (receiverSocketId) {
      this.server.to(receiverSocketId).emit('incoming-call', {
        from: fromUserId,
        offer: data.offer,
        type: data.type,
        conversationId: data.conversationId,
        callerName: data.callerName,
        callerAvatar: data.callerAvatar,
      });
    } else {
      client.emit('call-failed', { reason: 'User offline' });
      // Log missed call
      this.chatService.logCall(fromUserId, data.to, data.conversationId, data.type, 'MISSED', 0).then((res) => {
        if (res?.systemMessage) {
          this.server.emit(`message-${data.conversationId}`, res.systemMessage);
          this.server.emit('new-message-notification', res.systemMessage);
        }
      });
    }
  }

  @SubscribeMessage('accept-call')
  handleAcceptCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; answer: any }
  ) {
    const senderSocketId = this.activeUsers.get(data.to);
    if (senderSocketId) {
      this.server.to(senderSocketId).emit('call-accepted', {
        answer: data.answer,
      });
    }
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; candidate: any }
  ) {
    const receiverSocketId = this.activeUsers.get(data.to);
    if (receiverSocketId) {
      this.server.to(receiverSocketId).emit('ice-candidate', {
        candidate: data.candidate,
      });
    }
  }

  @SubscribeMessage('reject-call')
  handleRejectCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; conversationId: string; type: 'AUDIO' | 'VIDEO'; reason?: string }
  ) {
    const callerSocketId = this.activeUsers.get(data.to);
    if (callerSocketId) {
      this.server.to(callerSocketId).emit('call-rejected', { reason: data.reason });
    }
    const userId = client.data.userId;
    const status = data.reason === 'busy' ? 'BUSY' : 'REJECTED';
    this.chatService.logCall(data.to, userId, data.conversationId, data.type, status, 0).then((res) => {
      if (res?.systemMessage) {
        this.server.emit(`message-${data.conversationId}`, res.systemMessage);
        this.server.emit('new-message-notification', res.systemMessage);
      }
    });
  }

  @SubscribeMessage('end-call')
  handleEndCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; conversationId: string; type: 'AUDIO' | 'VIDEO'; duration: number }
  ) {
    const targetSocketId = this.activeUsers.get(data.to);
    if (targetSocketId) {
      this.server.to(targetSocketId).emit('call-ended');
    }
    const userId = client.data.userId;
    this.chatService.logCall(userId, data.to, data.conversationId, data.type, 'COMPLETED', data.duration).then((res) => {
      if (res?.systemMessage) {
        this.server.emit(`message-${data.conversationId}`, res.systemMessage);
        this.server.emit('new-message-notification', res.systemMessage);
      }
    });
  }

  // --- Group Call Signaling Events ---

  private async broadcastGroupCallStatus(conversationId: string) {
    const groupCall = this.activeGroupCalls.get(conversationId);
    const conversation = await this.chatService.getConversation(conversationId);
    if (!conversation) return;

    const data = groupCall && groupCall.participants.size > 0 ? {
      active: true,
      type: groupCall.type,
      startedAt: groupCall.startedAt,
      participantsCount: groupCall.participants.size,
    } : {
      active: false,
    };

    // Broadcast call status to all participants of this conversation
    for (const p of conversation.participants) {
      const peerSocketId = this.activeUsers.get(p.userId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit(`group-call-status-${conversationId}`, data);
      }
    }
  }

  /**
   * Initiator starts a group call. Server creates the group call room
   * and sends incoming notifications to all online participants.
   */
  @SubscribeMessage('group-call-initiate')
  async handleGroupCallInitiate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; type: 'AUDIO' | 'VIDEO' }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    // Prevent duplicate group calls on the same conversation
    if (this.activeGroupCalls.has(data.conversationId)) {
      client.emit('group-call-error', { reason: 'A group call is already active in this conversation.' });
      return;
    }

    // Look up conversation participants
    const conversation = await this.chatService.getConversation(data.conversationId);
    if (!conversation || !conversation.isGroup) {
      client.emit('group-call-error', { reason: 'Invalid group conversation.' });
      return;
    }

    // Create group call room with initiator and current timestamp
    const startedAt = Date.now();
    this.activeGroupCalls.set(data.conversationId, {
      type: data.type,
      participants: new Set<string>([userId]),
      startedAt,
      messages: [],
    });

    // Fetch initiator details
    const initiator = conversation.participants.find((p: any) => p.userId === userId);
    const initiatorName = initiator?.user?.name || initiator?.nickname || 'Someone';
    const initiatorAvatar = initiator?.user?.avatarUrl;
    const initiatorRole = initiator?.role || 'MEMBER';

    // Notify all other online participants
    for (const p of conversation.participants) {
      if (p.userId === userId) continue;
      const peerSocketId = this.activeUsers.get(p.userId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('group-call-incoming', {
          conversationId: data.conversationId,
          type: data.type,
          initiatorId: userId,
          initiatorName,
          initiatorAvatar,
          initiatorRole,
          groupName: conversation.name || 'Group',
          startedAt,
        });
      }
    }

    // Broadcast call status to everyone in the conversation
    this.broadcastGroupCallStatus(data.conversationId);

    // Confirm to initiator
    client.emit('group-call-started', {
      conversationId: data.conversationId,
      type: data.type,
      participants: [userId],
      myRole: initiatorRole,
      startedAt,
    });
  }

  /**
   * A participant accepts and joins the group call.
   * Server adds them and notifies existing participants to establish peer connections.
   */
  @SubscribeMessage('group-call-join')
  async handleGroupCallJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; type: 'AUDIO' | 'VIDEO' }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) {
      client.emit('group-call-error', { reason: 'No active group call found.' });
      return;
    }

    if (groupCall.participants.size >= this.MAX_GROUP_CALL_PARTICIPANTS) {
      client.emit('group-call-error', { reason: `Group call is full (max ${this.MAX_GROUP_CALL_PARTICIPANTS} participants).` });
      return;
    }

    // Fetch joiner details
    const conversation = await this.chatService.getConversation(data.conversationId);
    const joinerParticipant = conversation?.participants.find((p: any) => p.userId === userId);
    const joinerName = joinerParticipant?.user?.name || joinerParticipant?.nickname || 'Someone';
    const joinerAvatar = joinerParticipant?.user?.avatarUrl;
    const joinerRole = joinerParticipant?.role || 'MEMBER';

    // Get list of existing participants before adding new one
    const existingParticipantIds = Array.from(groupCall.participants);

    // Add joiner
    groupCall.participants.add(userId);

    // Build participant details for the joiner (so they know who's already in)
    const existingDetails = existingParticipantIds.map(pid => {
      const p = conversation?.participants.find((cp: any) => cp.userId === pid);
      return {
        userId: pid,
        name: p?.user?.name || p?.nickname || 'User',
        avatarUrl: p?.user?.avatarUrl,
        role: p?.role || 'MEMBER',
      };
    });

    // Tell the joiner about existing participants (they need to create offers to each)
    client.emit('group-call-joined', {
      conversationId: data.conversationId,
      type: groupCall.type,
      existingParticipants: existingDetails,
      myRole: joinerRole,
      startedAt: groupCall.startedAt,
      messages: groupCall.messages,
    });

    // Notify existing participants that a new user joined
    for (const peerId of existingParticipantIds) {
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('group-call-user-joined', {
          conversationId: data.conversationId,
          userId,
          name: joinerName,
          avatarUrl: joinerAvatar,
          role: joinerRole,
        });
      }
    }

    // Broadcast updated status
    this.broadcastGroupCallStatus(data.conversationId);
  }

  /**
   * Relay SDP offer between specific peers within a group call.
   */
  @SubscribeMessage('group-call-offer')
  handleGroupCallOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; offer: any; conversationId: string }
  ) {
    const fromUserId = client.data.userId;
    const targetSocketId = this.activeUsers.get(data.to);
    if (targetSocketId) {
      this.server.to(targetSocketId).emit('group-call-offer', {
        from: fromUserId,
        offer: data.offer,
        conversationId: data.conversationId,
      });
    }
  }

  /**
   * Relay SDP answer between specific peers within a group call.
   */
  @SubscribeMessage('group-call-answer')
  handleGroupCallAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; answer: any; conversationId: string }
  ) {
    const fromUserId = client.data.userId;
    const targetSocketId = this.activeUsers.get(data.to);
    if (targetSocketId) {
      this.server.to(targetSocketId).emit('group-call-answer', {
        from: fromUserId,
        answer: data.answer,
        conversationId: data.conversationId,
      });
    }
  }

  /**
   * Relay ICE candidates between specific peers within a group call.
   */
  @SubscribeMessage('group-ice-candidate')
  handleGroupIceCandidate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { to: string; candidate: any; conversationId: string }
  ) {
    const fromUserId = client.data.userId;
    const targetSocketId = this.activeUsers.get(data.to);
    if (targetSocketId) {
      this.server.to(targetSocketId).emit('group-ice-candidate', {
        from: fromUserId,
        candidate: data.candidate,
        conversationId: data.conversationId,
      });
    }
  }

  /**
   * A participant leaves the group call. Close only their connections.
   * Call ends only if the last person leaves.
   */
  @SubscribeMessage('group-call-leave')
  async handleGroupCallLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; duration?: number }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) return;

    groupCall.participants.delete(userId);

    // Notify remaining participants
    for (const peerId of groupCall.participants) {
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('group-call-user-left', {
          userId,
          conversationId: data.conversationId,
        });
      }
    }

    // If call is now empty or only 1 person left, end it completely
    if (groupCall.participants.size <= 1) {
      for (const lastPeerId of groupCall.participants) {
        const lastSocket = this.activeUsers.get(lastPeerId);
        if (lastSocket) {
          this.server.to(lastSocket).emit('group-call-ended', {
            conversationId: data.conversationId,
          });
        }
      }
      this.activeGroupCalls.delete(data.conversationId);

      // Log the completed group call
      await this.chatService.logGroupCall(userId, data.conversationId, groupCall.type, 'COMPLETED', data.duration || 0);
    }

    // Broadcast updated status
    this.broadcastGroupCallStatus(data.conversationId);
  }

  /**
   * A participant declines the group call invitation.
   */
  @SubscribeMessage('group-call-reject')
  handleGroupCallReject(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    // Just a decline/reject.
  }

  /**
   * Returns the current list of participants in an active group call.
   */
  @SubscribeMessage('group-call-status')
  handleGroupCallStatus(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    const groupCall = this.activeGroupCalls.get(data.conversationId);
    client.emit('group-call-status-response', {
      conversationId: data.conversationId,
      active: groupCall && groupCall.participants.size > 0,
      type: groupCall?.type,
      startedAt: groupCall?.startedAt,
      participants: groupCall ? Array.from(groupCall.participants) : [],
    });
  }

  /**
   * Relays an ephemeral emoji reaction to all users in the group call.
   */
  @SubscribeMessage('group-call-emoji')
  handleGroupCallEmoji(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; emoji: string }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) return;

    // Relay to other participants
    for (const peerId of groupCall.participants) {
      if (peerId === userId) continue;
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('group-call-emoji-received', {
          userId,
          emoji: data.emoji,
          conversationId: data.conversationId,
        });
      }
    }
  }

  /**
   * Relays an ephemeral chat message to all users in the group call.
   */
  @SubscribeMessage('group-call-chat-message')
  async handleGroupCallChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; message: string; senderName: string }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) return;

    const msg = {
      senderId: userId,
      senderName: data.senderName,
      message: data.message,
      timestamp: Date.now(),
      conversationId: data.conversationId,
    };
    groupCall.messages.push(msg);

    // Relay to other participants
    for (const peerId of groupCall.participants) {
      if (peerId === userId) continue;
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('group-call-chat-message-received', msg);
      }
    }
  }

  /**
   * Relays participant media states (video/audio enabled) to peers.
   */
  @SubscribeMessage('group-call-media-state')
  handleGroupCallMediaState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; videoEnabled: boolean; audioEnabled: boolean; handRaised?: boolean; footRaised?: boolean; isScreenSharing?: boolean }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) return;

    // Relay to other participants
    for (const peerId of groupCall.participants) {
      if (peerId === userId) continue;
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('group-call-media-state-received', {
          userId,
          videoEnabled: data.videoEnabled,
          audioEnabled: data.audioEnabled,
          handRaised: data.handRaised,
          footRaised: data.footRaised,
          isScreenSharing: data.isScreenSharing,
          conversationId: data.conversationId,
        });
      }
    }
  }

  /**
   * Admin/Creator/Moderator force mutes a particular participant in a group call.
   */
  @SubscribeMessage('group-call-admin-mute-user')
  async handleGroupCallAdminMuteUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; targetUserId: string }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) return;

    // Check sender role
    const role = await this.chatService.getParticipantRole(data.conversationId, userId);
    if (role !== 'CREATOR' && role !== 'ADMIN' && role !== 'MODERATOR') {
      client.emit('group-call-error', { reason: 'Only the creator, admin, or moderator can mute participants.' });
      return;
    }

    // Emit 'group-call-force-muted' to the target user if they are in the call
    if (groupCall.participants.has(data.targetUserId)) {
      const targetSocketId = this.activeUsers.get(data.targetUserId);
      if (targetSocketId) {
        this.server.to(targetSocketId).emit('group-call-force-muted', {
          conversationId: data.conversationId,
        });
      }
    }
  }

  /**
   * Admin/Creator/Moderator force unmutes a particular participant in a group call.
   */
  @SubscribeMessage('group-call-admin-unmute-user')
  async handleGroupCallAdminUnmuteUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; targetUserId: string }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) return;

    // Check sender role
    const role = await this.chatService.getParticipantRole(data.conversationId, userId);
    if (role !== 'CREATOR' && role !== 'ADMIN' && role !== 'MODERATOR') {
      client.emit('group-call-error', { reason: 'Only the creator, admin, or moderator can unmute participants.' });
      return;
    }

    // Emit 'group-call-force-unmuted' to the target user if they are in the call
    if (groupCall.participants.has(data.targetUserId)) {
      const targetSocketId = this.activeUsers.get(data.targetUserId);
      if (targetSocketId) {
        this.server.to(targetSocketId).emit('group-call-force-unmuted', {
          conversationId: data.conversationId,
        });
      }
    }
  }

  /**
   * Admin/Creator force mutes all other participants in a group call.
   */
  @SubscribeMessage('group-call-admin-mute-all')
  async handleGroupCallAdminMuteAll(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const groupCall = this.activeGroupCalls.get(data.conversationId);
    if (!groupCall) return;

    // Check user role
    const role = await this.chatService.getParticipantRole(data.conversationId, userId);
    if (role !== 'CREATOR' && role !== 'ADMIN' && role !== 'MODERATOR') {
      client.emit('group-call-error', { reason: 'Only the creator, admin, or moderator can mute all participants.' });
      return;
    }

    // Emit 'group-call-force-muted' to other participants in the call
    for (const peerId of groupCall.participants) {
      if (peerId === userId) continue;
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('group-call-force-muted', {
          conversationId: data.conversationId,
        });
      }
    }
  }
}
