import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DrizzleModule } from './infra/db/drizzle.module';
import { RedisModule } from './infra/redis/redis.module';
import { FirebaseModule } from './infra/firebase/firebase.module';
import { GoogleModule } from './infra/google/google.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { MetricsMiddleware } from './common/middleware/metrics.middleware';
import { AppExceptionFilter } from './common/filters/app-exception.filter';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 1000 }]),
    DrizzleModule,
    RedisModule,
    FirebaseModule,
    GoogleModule,
    HealthModule,
    AuthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, MetricsMiddleware).forRoutes('*');
  }
}
