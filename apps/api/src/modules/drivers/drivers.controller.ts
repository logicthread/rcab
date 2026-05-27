import { Controller, Patch, Body, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import { DriversService } from './drivers.service';
import { SetVehicleDto } from './dto/set-vehicle.dto';

@Controller('v1/drivers')
@UseGuards(AuthGuard)
export class DriversController {
  constructor(private drivers: DriversService) {}

  @Patch('me/vehicle')
  setVehicle(@Req() req: Request & { user: JwtPayload }, @Body() dto: SetVehicleDto) {
    if (req.user.role !== 'driver') {
      throw new ForbiddenException({ code: 'forbidden', message: 'Driver role required' });
    }
    return this.drivers.setCurrentVehicle(req.user.sub, dto.vehicle_id);
  }
}
