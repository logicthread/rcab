import { Controller, Post, Patch, Body, UseGuards, Req, ForbiddenException, HttpCode } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import { DriversService } from './drivers.service';
import { SetVehicleDto } from './dto/set-vehicle.dto';
import { GoOnlineDto } from './dto/go-online.dto';

@Controller('v1/drivers')
@UseGuards(AuthGuard)
export class DriversController {
  constructor(private drivers: DriversService) {}

  private assertDriver(user: JwtPayload): void {
    if (user.role !== 'driver') {
      throw new ForbiddenException({ code: 'forbidden', message: 'Driver role required' });
    }
  }

  @Patch('me/vehicle')
  setVehicle(@Req() req: Request & { user: JwtPayload }, @Body() dto: SetVehicleDto) {
    this.assertDriver(req.user);
    return this.drivers.setCurrentVehicle(req.user.sub, dto.vehicle_id);
  }

  @Post('online')
  goOnline(@Req() req: Request & { user: JwtPayload }, @Body() dto: GoOnlineDto) {
    this.assertDriver(req.user);
    return this.drivers.goOnline(req.user.sub, dto.lat, dto.lng);
  }

  @Post('offline')
  @HttpCode(200)
  goOffline(@Req() req: Request & { user: JwtPayload }) {
    this.assertDriver(req.user);
    return this.drivers.goOffline(req.user.sub);
  }
}
