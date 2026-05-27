import { Controller, Post, Body, UseGuards, HttpCode, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { FirebaseExchangeDto } from './dto/firebase-exchange.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { GoogleIdTokenDto } from './dto/google-id-token.dto';
import { AuthService, type TokenResponse } from './auth.service';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import { CsrfGuard } from '../../common/guards/csrf.guard';
import { REFRESH_COOKIE_NAME, refreshCookieOptions, clearCookieOptions } from '../../common/utils/cookie';

type PublicTokenResponse = Omit<TokenResponse, 'refresh_token'>;

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
}

function tokenBody(tokens: TokenResponse): PublicTokenResponse {
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    user: tokens.user,
  };
}

@Controller('v1/auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('firebase-exchange')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async firebaseExchange(
    @Body() dto: FirebaseExchangeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicTokenResponse> {
    const tokens = await this.auth.exchangeFirebaseToken(dto.id_token);
    setRefreshCookie(res, tokens.refresh_token);
    return tokenBody(tokens);
  }

  @Post('refresh')
  @UseGuards(CsrfGuard)
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicTokenResponse> {
    const token = dto.refresh_token ?? (req.cookies as Record<string, string>)[REFRESH_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException({ code: 'invalid_refresh_token', message: 'No refresh token provided' });
    }
    const tokens = await this.auth.refresh(token);
    setRefreshCookie(res, tokens.refresh_token);
    return tokenBody(tokens);
  }

  @Post('logout')
  @UseGuards(AuthGuard, CsrfGuard)
  @HttpCode(204)
  async logout(
    @Req() req: Request & { user: JwtPayload },
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = dto.refresh_token ?? (req.cookies as Record<string, string>)[REFRESH_COOKIE_NAME];
    if (token) {
      await this.auth.revoke(token, req.user.sub);
    }
    res.clearCookie(REFRESH_COOKIE_NAME, clearCookieOptions());
  }

  @Post('google/link')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async googleLink(
    @Req() req: Request & { user: JwtPayload },
    @Body() dto: GoogleIdTokenDto,
  ): Promise<void> {
    await this.auth.linkGoogle(req.user.sub, dto.google_id_token);
  }

  @Post('google/login')
  async googleLogin(
    @Body() dto: GoogleIdTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicTokenResponse> {
    const tokens = await this.auth.loginWithGoogle(dto.google_id_token);
    setRefreshCookie(res, tokens.refresh_token);
    return tokenBody(tokens);
  }
}
