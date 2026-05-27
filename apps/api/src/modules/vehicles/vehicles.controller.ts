import { Controller, Get, Post, Patch, Body, Param, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import { VehiclesService } from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

@Controller('v1/vehicles')
@UseGuards(AuthGuard)
export class VehiclesController {
  constructor(private vehicles: VehiclesService) {}

  private assertDriver(user: JwtPayload): void {
    if (user.role !== 'driver') {
      throw new ForbiddenException({ code: 'forbidden', message: 'Driver role required' });
    }
  }

  @Post()
  create(@Req() req: Request & { user: JwtPayload }, @Body() dto: CreateVehicleDto) {
    this.assertDriver(req.user);
    return this.vehicles.create(req.user.sub, dto);
  }

  @Get()
  findAll(@Req() req: Request & { user: JwtPayload }) {
    this.assertDriver(req.user);
    return this.vehicles.findAllForDriver(req.user.sub);
  }

  @Patch(':id')
  update(
    @Req() req: Request & { user: JwtPayload },
    @Param('id') id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    this.assertDriver(req.user);
    return this.vehicles.update(id, req.user.sub, dto);
  }
}
