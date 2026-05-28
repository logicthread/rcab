import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { RouteSimilarityService } from './route-similarity.service';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [RouteSimilarityService],
  exports: [RouteSimilarityService],
})
export class MatchingModule {}
