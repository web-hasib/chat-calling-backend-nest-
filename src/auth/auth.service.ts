import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService
  ) {}

  async register(profile: { email: string; name: string; username: string; password?: string; avatarUrl?: string }) {
    const existingEmail = await this.prisma.user.findUnique({
      where: { email: profile.email },
    });
    if (existingEmail) {
      throw new BadRequestException('Email already registered');
    }

    const existingUsername = await this.prisma.user.findUnique({
      where: { username: profile.username.toLowerCase() },
    });
    if (existingUsername) {
      throw new BadRequestException('Username is already taken');
    }

    let hashedPassword = undefined;
    if (profile.password) {
      hashedPassword = await bcrypt.hash(profile.password, 10);
    }

    const user = await this.prisma.user.create({
      data: {
        email: profile.email,
        username: profile.username.toLowerCase(),
        name: profile.name,
        password: hashedPassword,
        avatarUrl: profile.avatarUrl || `https://api.dicebear.com/7.x/adventurer/svg?seed=${profile.username}`,
      },
    });

    return user;
  }

  async validateUserCredentials(emailOrUsername: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: emailOrUsername.toLowerCase() },
          { username: emailOrUsername.toLowerCase() },
        ],
      },
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('Username or password incorrect');
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Username or password incorrect');
    }

    const { password: _, ...result } = user;
    return result;
  }

  async updateProfile(
    userId: string,
    data: {
      name?: string;
      username?: string;
      avatarUrl?: string;
      pushNotificationsEnabled?: boolean;
      soundEffectsEnabled?: boolean;
      messageTone?: string;
      callTone?: string;
    }
  ) {
    if (data.username) {
      const usernameLower = data.username.trim().toLowerCase();
      const existing = await this.prisma.user.findUnique({
        where: { username: usernameLower },
      });
      if (existing && existing.id !== userId) {
        throw new BadRequestException('Username is already taken');
      }
      data.username = usernameLower;
    }

    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  async validateOAuthUser(profile: { email: string; name: string; avatarUrl: string; username?: string }) {
    let user = await this.prisma.user.findUnique({
      where: { email: profile.email },
    });

    if (!user) {
      let desiredUsername = profile.username;
      
      // Auto-generate unique username if not provided
      if (!desiredUsername) {
        const base = profile.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
        desiredUsername = base;
        let count = 0;
        while (true) {
          const check = await this.prisma.user.findUnique({
            where: { username: desiredUsername },
          });
          if (!check) break;
          count++;
          desiredUsername = `${base}${count}`;
        }
      } else {
        // Validate if provided username is already taken
        const existingUsername = await this.prisma.user.findUnique({
          where: { username: desiredUsername },
        });
        if (existingUsername) {
          throw new BadRequestException('Username is already taken');
        }
      }

      user = await this.prisma.user.create({
        data: {
          email: profile.email,
          username: desiredUsername,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        },
      });
    }

    return user;
  }

  generateJwt(user: any) {
    const payload = { email: user.email, sub: user.id };
    return this.jwtService.sign(payload);
  }
}
