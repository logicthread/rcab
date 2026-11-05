import { Logger, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CsrfGuard } from '../../common/guards/csrf.guard';
import { resolveJwtSecret } from '../../common/guards/auth-config';
import { ACCESS_TOKEN_TTL_SECONDS, JWT_AUDIENCE, JWT_ISSUER } from '../../common/guards/access-token';

@Module({
  imports: [
    // Async so the secret is read (and validated) when the DI container is
    // built — after ConfigModule has loaded .env — not at import time. A
    // missing/weak JWT_SECRET outside development/test aborts startup (F11).
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: resolveJwtSecret(process.env, () =>
          new Logger('AuthModule').warn(
            'JWT_SECRET is unset: signing with the public development secret (development/test only)',
          ),
        ),
        signOptions: { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: ACCESS_TOKEN_TTL_SECONDS },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, CsrfGuard],
  exports: [AuthGuard, CsrfGuard, JwtModule],
})
export class AuthModule {}
