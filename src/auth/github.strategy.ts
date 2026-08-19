import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-github2';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    private configService: ConfigService,
    private authService: AuthService
  ) {
    super({
      clientID: configService.get<string>('GITHUB_CLIENT_ID', 'placeholder'),
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET', 'placeholder'),
      callbackURL: `${configService.get<string>('BACKEND_URL', 'http://localhost:5000')}/auth/github/callback`,
      scope: ['user:email'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: any
  ): Promise<any> {
    const { displayName, username, emails, photos } = profile;
    const email = emails?.[0]?.value || `${username}@github.com`;
    const user = await this.authService.validateOAuthUser({
      email,
      name: displayName || username,
      avatarUrl: photos?.[0]?.value || '',
    });
    done(null, user);
  }
}
