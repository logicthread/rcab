import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import {
  AccountService,
  type ProfileResponse,
  type SupportMessageDto,
} from './account.service';
import { SendSupportMessageDto, SubmitFeedbackDto, UpdateProfileDto } from './dto/account.dto';

type AuthedReq = Request & { user: JwtPayload };

/** Profile, in-app feedback and the support chat — shared by the web client and the driver app. */
@Controller('v1')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('me')
  getMe(@Req() req: AuthedReq): Promise<ProfileResponse> {
    return this.account.getProfile(req.user.sub);
  }

  @Patch('me')
  updateMe(@Req() req: AuthedReq, @Body() dto: UpdateProfileDto): Promise<ProfileResponse> {
    return this.account.updateDisplayName(req.user.sub, dto.displayName);
  }

  @Post('feedback')
  @HttpCode(201)
  submitFeedback(@Req() req: AuthedReq, @Body() dto: SubmitFeedbackDto): Promise<{ id: string }> {
    const role = req.user.role === 'driver' ? 'driver' : 'client';
    return this.account.submitFeedback(req.user.sub, role, dto.category, dto.message);
  }

  @Get('support/messages')
  async listSupport(@Req() req: AuthedReq): Promise<{ messages: SupportMessageDto[] }> {
    return { messages: await this.account.listSupport(req.user.sub) };
  }

  /** Returns the messages this send created (the user's, plus an acknowledgement on the first one). */
  @Post('support/messages')
  @HttpCode(201)
  async sendSupport(
    @Req() req: AuthedReq,
    @Body() dto: SendSupportMessageDto,
  ): Promise<{ messages: SupportMessageDto[] }> {
    return { messages: await this.account.sendSupport(req.user.sub, dto.body) };
  }
}
