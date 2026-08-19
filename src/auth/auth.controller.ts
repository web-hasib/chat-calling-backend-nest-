import { Controller, Get, Req, UseGuards, Res, Post, Put, Body } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('google')
  @UseGuards(AuthGuard('google'))
  async googleAuth() {}

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleAuthRedirect(@Req() req, @Res() res: Response) {
    const jwt = this.authService.generateJwt(req.user);
    return res.redirect(`http://localhost:3000/auth-callback?token=${jwt}`);
  }

  @Get('github')
  @UseGuards(AuthGuard('github'))
  async githubAuth() {}

  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  async githubAuthRedirect(@Req() req, @Res() res: Response) {
    const jwt = this.authService.generateJwt(req.user);
    return res.redirect(`http://localhost:3000/auth-callback?token=${jwt}`);
  }

  @Post('signup')
  async signup(@Body() body: { email: string; username: string; name: string; password?: string; avatarUrl?: string }) {
    const user = await this.authService.register(body);
    const token = this.authService.generateJwt(user);
    return { token, user };
  }

  @Post('login')
  async login(@Body() body: { emailOrUsername: string; password?: string }) {
    // If password is not provided (e.g. dev mode or empty), we can fail or handle it. We enforce it for standard login.
    const user = await this.authService.validateUserCredentials(body.emailOrUsername, body.password || '');
    const token = this.authService.generateJwt(user);
    return { token, user };
  }

  @UseGuards(JwtAuthGuard)
  @Put('profile')
  async updateProfile(
    @Req() req,
    @Body() body: {
      name?: string;
      username?: string;
      avatarUrl?: string;
      pushNotificationsEnabled?: boolean;
      soundEffectsEnabled?: boolean;
      messageTone?: string;
      callTone?: string;
    }
  ) {
    const user = await this.authService.updateProfile(req.user.id, body);
    return { user };
  }
}
