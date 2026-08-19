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
import { PrismaService } from '../prisma/prisma.service';

/**
 * WebSocketGateway decorators hook into the Socket.io adapter.
 * This class isolates Omegle-style "random chat" signaling.
 * It manages real-time socket connections for matchmaking, peer-to-peer WebRTC signaling,
 * and ephemeral text messages without touching the main chat module or the database.
 */
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: false,
  },
})
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server; // Direct access to the socket.io Server instance to emit/broadcast

  /**
   * IN-MEMORY STATE SYSTEM (Industry Standard for Ephemeral Matchmaking Performance):
   * Using database writes/reads for matching thousands of fast-skipping users creates major DB lock issues.
   * Instead, we track state in memory:
   */
  
  // Maps logged-in User ID to their current socket connection ID: userId -> socketId
  private activeUsers = new Map<string, string>();
  
  // Matchmaking queue containing User IDs waiting to be paired
  private liveQueue: string[] = [];
  
  // Active pairings map: bi-directional mappings of userId -> peerUserId
  private liveMatches = new Map<string, string>();

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService
  ) {}

  /**
   * Connection Handler:
   * Validates JWT token passed via authorization headers or handshake parameters on initial connection.
   * If valid, stores the connection mapping and binds user information to the socket object.
   */
  async handleConnection(client: Socket) {
    try {
      const authHeader = client.handshake.headers.authorization || client.handshake.auth?.token;
      if (!authHeader) {
        client.disconnect();
        return;
      }

      // Extract JWT Bearer token
      const token = authHeader.replace('Bearer ', '');
      const payload = this.jwtService.verify(token);
      const userId = payload.sub;

      // Bind user identity data onto the socket instance itself
      client.data.userId = userId;
      
      // Register socket ID for real-time addressing
      this.activeUsers.set(userId, client.id);
    } catch (e) {
      // Disconnect socket immediately on failed validation
      client.disconnect();
    }
  }

  /**
   * Disconnection Handler:
   * Cleans up the disconnected user from matchmaking queues and matches to prevent dead links.
   */
  handleDisconnect(client: Socket) {
    const userId = client.data.userId;
    if (userId) {
      if (this.activeUsers.get(userId) === client.id) {
        this.activeUsers.delete(userId);
        this.cleanupLiveUser(userId);
      }
    }
  }

  /**
   * Helper method to clean up matchmaking queues and notify peers of disconnection
   */
  private cleanupLiveUser(userId: string) {
    // 1. Remove user from matchmaking queue if present
    this.liveQueue = this.liveQueue.filter(id => id !== userId);
    
    // 2. Locate active peer if user is currently matched
    const peerId = this.liveMatches.get(userId);
    if (peerId) {
      // Clean up bi-directional maps
      this.liveMatches.delete(userId);
      this.liveMatches.delete(peerId);

      // Notify the active peer so their WebRTC connection can close and they can handle state changes
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('live-peer-disconnected');
      }
    }
  }

  // --- Live Omegle-style Matchmaking Events ---

  /**
   * Event: join-live-queue
   * Places the user in the matchmaking queue and attempts to pair them with another waiting user.
   */
  @SubscribeMessage('join-live-queue')
  async handleJoinLiveQueue(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId;
    if (!userId) return;

    // Ensure they are cleaned up from any old match first
    this.cleanupLiveUser(userId);

    let peerId: string | undefined;

    // Shift users out of the queue until we find a valid, online candidate
    while (this.liveQueue.length > 0) {
      const candidateId = this.liveQueue.shift();
      // Ensure candidate is valid, online, and not the same user
      if (candidateId && candidateId !== userId && this.activeUsers.has(candidateId)) {
        peerId = candidateId;
        break;
      }
    }

    if (peerId) {
      // Establish pairing in active matches map
      this.liveMatches.set(userId, peerId);
      this.liveMatches.set(peerId, userId);

      // Retrieve display details (name, username, avatar) from Prisma
      const userDetails = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, name: true, avatarUrl: true },
      });

      const peerDetails = await this.prisma.user.findUnique({
        where: { id: peerId },
        select: { id: true, username: true, name: true, avatarUrl: true },
      });

      const clientSocketId = client.id;
      const peerSocketId = this.activeUsers.get(peerId);

      if (peerSocketId) {
        // Emit match event to initiator (who starts WebRTC connection negotiation)
        this.server.to(clientSocketId).emit('live-match-found', {
          peer: peerDetails,
          role: 'initiator',
        });

        // Emit match event to receiver (who listens for WebRTC incoming offer)
        this.server.to(peerSocketId).emit('live-match-found', {
          peer: userDetails,
          role: 'receiver',
        });
      } else {
        // Fallback: If peer went offline mid-handshake, place current user back in queue
        this.liveQueue.push(userId);
        client.emit('waiting-in-queue');
      }
    } else {
      // If no valid candidates in queue, place current user in queue and notify client
      this.liveQueue.push(userId);
      client.emit('waiting-in-queue');
    }
  }

  /**
   * Event: leave-live-queue
   * Removes user from queue if they cancel matchmaking search.
   */
  @SubscribeMessage('leave-live-queue')
  handleLeaveLiveQueue(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId;
    if (userId) {
      this.liveQueue = this.liveQueue.filter(id => id !== userId);
    }
  }

  /**
   * Event: skip-live
   * Breaks the active match (notifying the peer) and automatically triggers matching search again.
   */
  @SubscribeMessage('skip-live')
  async handleSkipLive(@ConnectedSocket() client: Socket) {
    const userId = client.data.userId;
    if (!userId) return;

    const peerId = this.liveMatches.get(userId);
    if (peerId) {
      // Disconnect current pairing
      this.liveMatches.delete(userId);
      this.liveMatches.delete(peerId);

      // Alert the peer they were skipped
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('live-peer-skipped');
      }
    }

    // Auto-re-queue current user
    await this.handleJoinLiveQueue(client);
  }

  /**
   * Event: send-live-message
   * Relays a text message directly to the active peer's socket.
   * This is entirely ephemeral, skipping database saves for high scalability.
   */
  @SubscribeMessage('send-live-message')
  handleSendLiveMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { content: string }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const peerId = this.liveMatches.get(userId);
    if (peerId) {
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('live-message-received', {
          senderId: userId,
          content: data.content,
          createdAt: new Date(),
        });
      }
    }
  }

  /**
   * Event: live-webrtc-signal
   * Relays standard WebRTC signaling payloads (SDP Offers/Answers, ICE candidates) between peers.
   */
  @SubscribeMessage('live-webrtc-signal')
  handleLiveWebRTCSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { signal: any }
  ) {
    const userId = client.data.userId;
    if (!userId) return;

    const peerId = this.liveMatches.get(userId);
    if (peerId) {
      const peerSocketId = this.activeUsers.get(peerId);
      if (peerSocketId) {
        this.server.to(peerSocketId).emit('live-webrtc-signal', {
          signal: data.signal,
        });
      }
    }
  }
}
