import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AccountController } from './account.controller';
import { SendSupportMessageDto, SubmitFeedbackDto, UpdateProfileDto } from './dto/account.dto';
import type { AccountService } from './account.service';

function setup() {
  const svc = {
    getProfile: vi.fn().mockResolvedValue({ id: 'u1' }),
    updateDisplayName: vi.fn().mockResolvedValue({ id: 'u1', displayName: 'Asha' }),
    submitFeedback: vi.fn().mockResolvedValue({ id: 'f1' }),
    listSupport: vi.fn().mockResolvedValue([{ id: 'm1' }]),
    sendSupport: vi.fn().mockResolvedValue([{ id: 'm2' }]),
  };
  const ctrl = new AccountController(svc as unknown as AccountService);
  return { svc, ctrl };
}
const req = (role: string) => ({ user: { sub: 'u1', role } }) as never;

describe('AccountController', () => {
  it('reads and updates the caller’s own profile', async () => {
    const { svc, ctrl } = setup();
    await ctrl.getMe(req('client'));
    expect(svc.getProfile).toHaveBeenCalledWith('u1');
    await ctrl.updateMe(req('client'), { displayName: 'Asha' });
    expect(svc.updateDisplayName).toHaveBeenCalledWith('u1', 'Asha');
  });

  it('stores feedback under the caller’s role', async () => {
    const { svc, ctrl } = setup();
    await ctrl.submitFeedback(req('driver'), { category: 'bug', message: 'app froze' });
    expect(svc.submitFeedback).toHaveBeenCalledWith('u1', 'driver', 'bug', 'app froze');
    await ctrl.submitFeedback(req('client'), { category: 'idea', message: 'dark mode' });
    expect(svc.submitFeedback).toHaveBeenLastCalledWith('u1', 'client', 'idea', 'dark mode');
  });

  it('wraps support messages in { messages }', async () => {
    const { svc, ctrl } = setup();
    expect(await ctrl.listSupport(req('client'))).toEqual({ messages: [{ id: 'm1' }] });
    expect(await ctrl.sendSupport(req('client'), { body: 'help' })).toEqual({
      messages: [{ id: 'm2' }],
    });
    expect(svc.sendSupport).toHaveBeenCalledWith('u1', 'help');
  });
});

describe('account DTO validation', () => {
  const errs = (cls: new () => object, plain: object) => validate(plainToInstance(cls, plain));

  it('rejects an unknown feedback category and empty/oversized text', async () => {
    expect(await errs(SubmitFeedbackDto, { category: 'rant', message: 'x' })).not.toHaveLength(0);
    expect(await errs(SubmitFeedbackDto, { category: 'bug', message: '   ' })).not.toHaveLength(0);
    expect(
      await errs(SubmitFeedbackDto, { category: 'bug', message: 'x'.repeat(2001) }),
    ).not.toHaveLength(0);
    expect(await errs(SubmitFeedbackDto, { category: 'bug', message: 'ok' })).toHaveLength(0);
  });

  it('trims and bounds names and chat messages', async () => {
    expect(await errs(UpdateProfileDto, { displayName: '  ' })).not.toHaveLength(0);
    expect(await errs(UpdateProfileDto, { displayName: 'a'.repeat(81) })).not.toHaveLength(0);
    expect(await errs(SendSupportMessageDto, { body: '' })).not.toHaveLength(0);
    expect(await errs(SendSupportMessageDto, { body: 'hello' })).toHaveLength(0);
  });
});
