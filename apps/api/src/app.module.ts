import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
import { DrizzleModule } from './infra/db/drizzle.module';
import { RedisModule } from './infra/redis/redis.module';
import { FirebaseModule } from './infra/firebase/firebase.module';
import { GoogleModule } from './infra/google/google.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RidesModule } from './modules/rides/rides.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { RideLifecycleModule } from './modules/ride-lifecycle/ride-lifecycle.module';
import { RatingModule } from './modules/rating/rating.module';
import { ScheduledModule } from './modules/scheduled/scheduled.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { MetricsMiddleware } from './common/middleware/metrics.middleware';
import { AppExceptionFilter } from './common/filters/app-exception.filter';

function parseRedisConnection() {
  const raw = process.env.REDIS_URL ?? 'redis://redis:6379';
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 1000 }]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    BullModule.forRoot({ connection: parseRedisConnection() }),
    DrizzleModule,
    RedisModule,
    FirebaseModule,
    GoogleModule,
    HealthModule,
    AuthModule,
    VehiclesModule,
    DriversModule,
    RealtimeModule,
    RidesModule,
    DispatchModule,
    RideLifecycleModule,
    RatingModule,
    ScheduledModule,
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
