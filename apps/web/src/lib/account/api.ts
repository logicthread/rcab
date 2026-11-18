import { getJson, patchJson, postJson } from '../booking/api';

export interface Profile {
  id: string;
  role: 'client' | 'driver';
  displayName: string | null;
  email: string | null;
  phone: string | null;
  memberSince: string;
}

export type FeedbackCategory = 'bug' | 'idea' | 'compliment' | 'other';

export interface SupportMessage {
  id: string;
  sender: 'user' | 'support';
  body: string;
  createdAt: string;
}

export const fetchProfile = () => getJson<Profile>('/v1/me');

export const updateProfileName = (displayName: string) =>
  patchJson<Profile>('/v1/me', { displayName });

export const submitFeedback = (category: FeedbackCategory, message: string) =>
  postJson<{ id: string }>('/v1/feedback', { category, message });

export async function fetchSupportMessages(): Promise<SupportMessage[]> {
  return (await getJson<{ messages: SupportMessage[] }>('/v1/support/messages')).messages;
}

export async function sendSupportMessage(body: string): Promise<SupportMessage[]> {
  return (await postJson<{ messages: SupportMessage[] }>('/v1/support/messages', { body }))
    .messages;
}
