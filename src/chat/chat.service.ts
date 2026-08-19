import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

async function fetchLinkPreview(content?: string) {
  if (!content) return null;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const match = content.match(urlRegex);
  if (!match) return null;
  const targetUrl = match[0];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();

    const getMetaContent = (prop: string) => {
      const match =
        html.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) ||
        html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i')) ||
        html.match(new RegExp(`<meta[^>]*name=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) ||
        html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${prop}["']`, 'i'));
      return match ? match[1] : null;
    };

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = getMetaContent('og:title') || getMetaContent('twitter:title') || (titleMatch ? titleMatch[1] : null);
    const description = getMetaContent('og:description') || getMetaContent('twitter:description') || getMetaContent('description');
    const image = getMetaContent('og:image') || getMetaContent('twitter:image');
    let siteName = getMetaContent('og:site_name');
    if (!siteName) {
      try {
        siteName = new URL(targetUrl).hostname;
      } catch (e) {
        siteName = null;
      }
    }

    if (!title && !description) return null;

    return {
      url: targetUrl,
      title: title?.trim() || null,
      description: description?.trim() || null,
      image: image || null,
      siteName: siteName?.trim() || null,
    };
  } catch (e) {
    return null;
  }
}

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  async createMessage(
    senderId: string,
    conversationId: string,
    content?: string,
    fileUrl?: string,
    fileType?: string,
    replyToId?: string
  ) {
    const linkPreview = await fetchLinkPreview(content);

    return this.prisma.message.create({
      data: {
        senderId,
        conversationId,
        content,
        fileUrl,
        fileType,
        replyToId,
        linkPreview: linkPreview ? (linkPreview as any) : undefined,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            avatarUrl: true,
          },
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            fileUrl: true,
            fileType: true,
            sender: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        reactions: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });
  }

  async getConversations(userId: string) {
    const convos = await this.prisma.conversation.findMany({
      where: {
        participants: {
          some: { userId },
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                username: true,
                avatarUrl: true,
              },
            },
          },
        },
        messages: {
          where: {
            NOT: {
              deletedFor: {
                has: userId,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            sender: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Compute unread messages count for each conversation
    const convosWithUnread = await Promise.all(
      convos.map(async (convo) => {
        const unreadCount = await this.prisma.message.count({
          where: {
            conversationId: convo.id,
            senderId: { not: userId },
            isRead: false,
            NOT: {
              deletedFor: {
                has: userId,
              },
            },
          },
        });
        return {
          ...convo,
          unreadCount,
        };
      })
    );

    return convosWithUnread;
  }

  async getOrCreateConversation(userId1: string, userId2: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { participants: { some: { userId: userId1 } } },
          { participants: { some: { userId: userId2 } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                username: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });

    if (existing) return existing;

    return this.prisma.conversation.create({
      data: {
        isGroup: false,
        participants: {
          create: [
            { userId: userId1 },
            { userId: userId2 },
          ],
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                username: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
  }

  async getMessages(conversationId: string, userId: string, cursor?: string, take = 20) {
    const limit = Number(take) || 20;

    let whereClause: any = {
      conversationId,
      NOT: {
        deletedFor: {
          has: userId,
        },
      },
    };

    if (cursor) {
      const cursorMessage = await this.prisma.message.findUnique({
        where: { id: cursor },
        select: { createdAt: true },
      });

      if (cursorMessage) {
        whereClause.createdAt = {
          lt: cursorMessage.createdAt,
        };
      }
    }

    const messages = await this.prisma.message.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            fileUrl: true,
            fileType: true,
            sender: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        reactions: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    // Return chronological order
    const sortedMessages = items.reverse();

    return {
      messages: sortedMessages,
      nextCursor,
      hasMore,
    };
  }

  async markAsRead(conversationId: string, userId: string) {
    const now = new Date();
    const result = await this.prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: now,
      },
    });

    return {
      count: result.count,
      conversationId,
      readAt: now,
    };
  }

  async toggleReaction(messageId: string, userId: string, emoji: string) {
    const existing = await this.prisma.messageReaction.findUnique({
      where: {
        messageId_userId: {
          messageId,
          userId,
        },
      },
    });

    if (existing) {
      if (existing.emoji === emoji) {
        // Remove reaction if clicking the same emoji
        await this.prisma.messageReaction.delete({
          where: { id: existing.id },
        });
      } else {
        // Update reaction to the new emoji
        await this.prisma.messageReaction.update({
          where: { id: existing.id },
          data: { emoji },
        });
      }
    } else {
      await this.prisma.messageReaction.create({
        data: {
          messageId,
          userId,
          emoji,
        },
      });
    }

    // Return updated reactions for the message
    return this.prisma.messageReaction.findMany({
      where: { messageId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  async deleteMessageForMe(messageId: string, userId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
    });
    if (!message) return null;

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        deletedFor: {
          push: userId,
        },
      },
    });

    return { conversationId: message.conversationId, messageId, mode: 'me', userId };
  }

  async deleteMessageForEveryone(messageId: string, userId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { sender: true },
    });
    if (!message) return null;
    if (message.senderId !== userId) return null; // Only sender can delete for everyone

    await this.prisma.messageReaction.deleteMany({
      where: { messageId },
    });

    const senderName = message.sender?.name || 'User';
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        content: `${senderName} removed this message`,
        fileUrl: null,
        fileType: null,
      },
    });

    return { conversationId: message.conversationId, messageId, mode: 'everyone' };
  }

  async logCall(
    callerId: string,
    receiverId: string,
    conversationId: string,
    type: 'AUDIO' | 'VIDEO',
    status: 'MISSED' | 'COMPLETED' | 'REJECTED' | 'BUSY',
    duration?: number
  ) {
    const log = await this.prisma.callLog.create({
      data: {
        callerId,
        receiverId,
        conversationId,
        type,
        status,
        duration: duration || 0,
      },
    });

    const formatDuration = (sec: number) => {
      const mins = Math.floor(sec / 60);
      const secs = sec % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    let text = '';
    const label = type === 'VIDEO' ? 'Video Call' : 'Voice Call';
    if (status === 'COMPLETED') {
      text = `${label} - Completed (${formatDuration(duration || 0)})`;
    } else if (status === 'REJECTED') {
      text = `${label} - Declined`;
    } else if (status === 'BUSY') {
      text = `${label} - Busy`;
    } else {
      text = `${label} - Missed`;
    }

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: callerId,
        conversationId,
        content: text,
        isSystem: true,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });

    return { log, systemMessage };
  }

  async logGroupCall(
    initiatorId: string,
    conversationId: string,
    type: 'AUDIO' | 'VIDEO',
    status: 'COMPLETED' | 'MISSED',
    duration?: number
  ) {
    const formatDuration = (sec: number) => {
      const mins = Math.floor(sec / 60);
      const secs = sec % 60;
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const label = type === 'VIDEO' ? 'Group Video Call' : 'Group Voice Call';
    let text = '';
    if (status === 'COMPLETED') {
      text = `${label} - Ended (${formatDuration(duration || 0)})`;
    } else {
      text = `${label} - Missed`;
    }

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: initiatorId,
        conversationId,
        content: text,
        isSystem: true,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });

    return { systemMessage };
  }

  async getConversation(conversationId: string) {
    return this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });
  }

  async updateConversationSettings(
    conversationId: string,
    userId: string,
    data: {
      themeColor?: string;
      themeGradient?: string;
      bgImage?: string;
      defaultEmoji?: string;
      nicknameTargetUserId?: string;
      nickname?: string;
    }
  ) {
    const convo = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (convo?.isGroup && (data.themeColor !== undefined || data.themeGradient !== undefined || data.bgImage !== undefined || data.defaultEmoji !== undefined)) {
      const userRole = await this.getParticipantRole(conversationId, userId);
      if (userRole !== 'CREATOR' && userRole !== 'ADMIN' && userRole !== 'MODERATOR') return null;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;

    let systemText = '';
    const updateData: any = {};

    if (data.themeColor !== undefined) updateData.themeColor = data.themeColor;
    if (data.themeGradient !== undefined) updateData.themeGradient = data.themeGradient;
    if (data.bgImage !== undefined) updateData.bgImage = data.bgImage;
    if (data.defaultEmoji !== undefined) updateData.defaultEmoji = data.defaultEmoji;

    if (Object.keys(updateData).length > 0) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: updateData,
      });

      if (data.themeColor !== undefined || data.themeGradient !== undefined) {
        systemText = `${user.name || user.username} changed the chat theme.`;
      } else if (data.bgImage !== undefined) {
        systemText = `${user.name || user.username} updated the chat background.`;
      } else if (data.defaultEmoji !== undefined) {
        systemText = `${user.name || user.username} set the quick emoji to ${data.defaultEmoji}.`;
      }
    }

    if (data.nicknameTargetUserId !== undefined) {
      const targetUser = await this.prisma.user.findUnique({ where: { id: data.nicknameTargetUserId } });
      const targetName = targetUser?.name || targetUser?.username || 'user';
      const cleanNickname = data.nickname?.trim() || null;

      await this.prisma.conversationParticipant.updateMany({
        where: {
          conversationId,
          userId: data.nicknameTargetUserId,
        },
        data: {
          nickname: cleanNickname,
        },
      });

      if (cleanNickname) {
        systemText = `${user.name || user.username} set the nickname for ${targetName} to "${cleanNickname}".`;
      } else {
        systemText = `${user.name || user.username} cleared the nickname for ${targetName}.`;
      }
    }

    let systemMessage: any = null;
    if (systemText) {
      systemMessage = await this.prisma.message.create({
        data: {
          senderId: userId,
          conversationId,
          content: systemText,
          isSystem: true,
        },
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              email: true,
              username: true,
              avatarUrl: true,
            },
          },
        },
      });
    }

    const updatedConvo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    });

    return {
      conversation: updatedConvo,
      systemMessage,
    };
  }

  async createGroupConversation(creatorId: string, name: string, avatarUrl: string, participantIds: string[]) {
    const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();

    const creatorUser = await this.prisma.user.findUnique({ where: { id: creatorId } });
    const creatorName = creatorUser?.name || creatorUser?.username || 'Creator';

    const convo = await this.prisma.conversation.create({
      data: {
        isGroup: true,
        name,
        avatarUrl,
        inviteCode,
        participants: {
          create: [
            { userId: creatorId, role: 'CREATOR' },
            ...participantIds.map(id => ({ userId: id, role: 'MEMBER' }))
          ]
        }
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, name: true, email: true, username: true, avatarUrl: true }
            }
          }
        }
      }
    });

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: creatorId,
        conversationId: convo.id,
        content: `${creatorName} created the group "${name}"`,
        isSystem: true,
      },
      include: {
        sender: {
          select: { id: true, name: true, email: true, avatarUrl: true }
        }
      }
    });

    return { conversation: convo, systemMessage };
  }

  async joinGroupByInviteCode(inviteCode: string, userId: string) {
    const convo = await this.prisma.conversation.findUnique({
      where: { inviteCode },
      include: { participants: true }
    });
    if (!convo) return null;

    const alreadyIn = convo.participants.some(p => p.userId === userId);
    if (alreadyIn) return { conversation: convo, systemMessage: null };

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userName = user?.name || user?.username || 'User';

    const updatedConvo = await this.prisma.conversation.update({
      where: { id: convo.id },
      data: {
        participants: {
          create: { userId, role: 'MEMBER' }
        }
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, username: true, avatarUrl: true } }
          }
        }
      }
    });

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: userId,
        conversationId: convo.id,
        content: `${userName} joined the group via invitation link`,
        isSystem: true,
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatarUrl: true } }
      }
    });

    return { conversation: updatedConvo, systemMessage };
  }

  async leaveGroup(conversationId: string, userId: string) {
    const participant = await this.prisma.conversationParticipant.findUnique({
      where: { userId_conversationId: { userId, conversationId } },
      include: { conversation: { include: { participants: true } } }
    });
    if (!participant) return null;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userName = user?.name || user?.username || 'User';

    await this.prisma.conversationParticipant.delete({
      where: { id: participant.id }
    });

    const remainingParticipants = participant.conversation.participants.filter(p => p.userId !== userId);

    let systemText = `${userName} left the group`;
    let newCreatorId = null;

    if (remainingParticipants.length === 0) {
      await this.prisma.conversation.delete({ where: { id: conversationId } });
      return { deleted: true, conversationId };
    }

    if (participant.role === 'CREATOR') {
      const nextInLine = remainingParticipants.find(p => p.role === 'ADMIN') ||
                         remainingParticipants.find(p => p.role === 'MODERATOR') ||
                         remainingParticipants[0];
      
      await this.prisma.conversationParticipant.update({
        where: { id: nextInLine.id },
        data: { role: 'CREATOR' }
      });
      newCreatorId = nextInLine.userId;
      const targetUser = await this.prisma.user.findUnique({ where: { id: nextInLine.userId } });
      const targetName = targetUser?.name || targetUser?.username || 'User';
      systemText += `, and ${targetName} was promoted to Creator`;
    }

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: userId,
        conversationId,
        content: systemText,
        isSystem: true,
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatarUrl: true } }
      }
    });

    const updatedConvo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, username: true, avatarUrl: true } }
          }
        }
      }
    });

    return { conversation: updatedConvo, systemMessage, deleted: false, newCreatorId };
  }

  async updateGroupSettings(conversationId: string, userId: string, name?: string, avatarUrl?: string) {
    const userRole = await this.getParticipantRole(conversationId, userId);
    if (userRole !== 'CREATOR' && userRole !== 'ADMIN' && userRole !== 'MODERATOR') return null;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userName = user?.name || user?.username || 'User';

    const updateData: any = {};
    let systemText = '';

    if (name) {
      updateData.name = name;
      systemText = `${userName} changed the group name to "${name}"`;
    }
    if (avatarUrl) {
      updateData.avatarUrl = avatarUrl;
      if (systemText) {
        systemText += ` and updated the group icon`;
      } else {
        systemText = `${userName} updated the group icon`;
      }
    }

    const convo = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: updateData,
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, avatarUrl: true } }
          }
        }
      }
    });

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: userId,
        conversationId,
        content: systemText,
        isSystem: true
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatarUrl: true } }
      }
    });

    return { conversation: convo, systemMessage };
  }

  async updateParticipantRole(conversationId: string, userId: string, targetUserId: string, newRole: string) {
    const userRole = await this.getParticipantRole(conversationId, userId);
    if (userRole !== 'CREATOR') return null;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userName = user?.name || user?.username || 'User';

    const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    const targetName = targetUser?.name || targetUser?.username || 'User';

    await this.prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: targetUserId },
      data: { role: newRole }
    });

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: userId,
        conversationId,
        content: `${userName} promoted ${targetName} to ${newRole.charAt(0).toUpperCase() + newRole.slice(1).toLowerCase()}`,
        isSystem: true
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatarUrl: true } }
      }
    });

    const convo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, username: true, avatarUrl: true } }
          }
        }
      }
    });

    return { conversation: convo, systemMessage };
  }

  async addMembers(conversationId: string, userId: string, targetUserIds: string[]) {
    const userRole = await this.getParticipantRole(conversationId, userId);
    if (userRole !== 'CREATOR' && userRole !== 'ADMIN' && userRole !== 'MODERATOR') return null;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userName = user?.name || user?.username || 'User';

    const addedParticipantsData = targetUserIds.map(id => ({ userId: id, role: 'MEMBER' }));

    await this.prisma.conversationParticipant.createMany({
      data: addedParticipantsData.map(p => ({
        conversationId,
        userId: p.userId,
        role: p.role
      })),
      skipDuplicates: true
    });

    const addedUsers = await this.prisma.user.findMany({
      where: { id: { in: targetUserIds } }
    });
    const addedNames = addedUsers.map(u => u.name || u.username).join(', ');

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: userId,
        conversationId,
        content: `${userName} added ${addedNames} to the group`,
        isSystem: true
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatarUrl: true } }
      }
    });

    const convo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, avatarUrl: true } }
          }
        }
      }
    });

    return { conversation: convo, systemMessage };
  }

  async removeMember(conversationId: string, userId: string, targetUserId: string) {
    const userRole = await this.getParticipantRole(conversationId, userId);
    const targetRole = await this.getParticipantRole(conversationId, targetUserId);
    if (!userRole || !targetRole) return null;

    let hasPermission = false;
    if (userRole === 'CREATOR') {
      hasPermission = true;
    } else if (userRole === 'ADMIN' && targetRole !== 'CREATOR') {
      hasPermission = true;
    } else if (userRole === 'MODERATOR' && targetRole === 'MEMBER') {
      hasPermission = true;
    }

    if (!hasPermission) return null;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userName = user?.name || user?.username || 'User';

    const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    const targetName = targetUser?.name || targetUser?.username || 'User';

    await this.prisma.conversationParticipant.deleteMany({
      where: { conversationId, userId: targetUserId }
    });

    const systemMessage = await this.prisma.message.create({
      data: {
        senderId: userId,
        conversationId,
        content: `${userName} removed ${targetName} from the group`,
        isSystem: true
      },
      include: {
        sender: { select: { id: true, name: true, email: true, avatarUrl: true } }
      }
    });

    const convo = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, avatarUrl: true } }
          }
        }
      }
    });

    return { conversation: convo, systemMessage };
  }

  async deleteGroup(conversationId: string, userId: string) {
    const userRole = await this.getParticipantRole(conversationId, userId);
    if (userRole !== 'CREATOR' && userRole !== 'ADMIN') return null;

    await this.prisma.messageReaction.deleteMany({
      where: { message: { conversationId } }
    });
    await this.prisma.message.deleteMany({
      where: { conversationId }
    });
    await this.prisma.conversationParticipant.deleteMany({
      where: { conversationId }
    });
    return this.prisma.conversation.delete({
      where: { id: conversationId }
    });
  }

  async getParticipantRole(conversationId: string, userId: string): Promise<string | null> {
    const p = await this.prisma.conversationParticipant.findUnique({
      where: { userId_conversationId: { userId, conversationId } }
    });
    return p ? p.role : null;
  }
}
