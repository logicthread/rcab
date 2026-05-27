import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FirebaseExchangeDto } from './dto/firebase-exchange.dto';
import { AuthService } from './auth.service';

@Controller('v1/auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('firebase-exchange')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async firebaseExchange(@Body() dto: FirebaseExchangeDto) {
    return this.auth.exchangeFirebaseToken(dto.id_token);
  }
}
