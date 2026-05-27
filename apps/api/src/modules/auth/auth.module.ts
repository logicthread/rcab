import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CsrfGuard } from '../../common/guards/csrf.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-prod',
      signOptions: { issuer: 'rcab', expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, CsrfGuard],
  exports: [AuthGuard, CsrfGuard, JwtModule],
})
export class AuthModule {}
