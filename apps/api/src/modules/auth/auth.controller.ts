import { Controller, Post, Body, UseGuards, HttpCode, Req } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FirebaseExchangeDto } from './dto/firebase-exchange.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { GoogleIdTokenDto } from './dto/google-id-token.dto';
import { AuthService } from './auth.service';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';

@Controller('v1/auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('firebase-exchange')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async firebaseExchange(@Body() dto: FirebaseExchangeDto) {
    return this.auth.exchangeFirebaseToken(dto.id_token);
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  @Post('logout')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  async logout(
    @Req() req: { user: JwtPayload },
    @Body() dto: RefreshTokenDto,
  ): Promise<void> {
    await this.auth.revoke(dto.refresh_token, req.user.sub);
  }

  @Post('google/link')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async googleLink(
    @Req() req: { user: JwtPayload },
    @Body() dto: GoogleIdTokenDto,
  ): Promise<void> {
    await this.auth.linkGoogle(req.user.sub, dto.google_id_token);
  }

  @Post('google/login')
  async googleLogin(@Body() dto: GoogleIdTokenDto) {
    return this.auth.loginWithGoogle(dto.google_id_token);
  }
}
