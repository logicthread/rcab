import { Global, Module } from '@nestjs/common';
import { GoogleVerifierService } from './google-verifier.service';

@Global()
@Module({
  providers: [GoogleVerifierService],
  exports: [GoogleVerifierService],
})
export class GoogleModule {}
