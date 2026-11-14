import { WEB_POLICY } from '../../config/policy';

/** Slack added to the minimum lead so a pickup that is valid when picked is still valid when submitted. */
const SUBMIT_SLACK_MS = 60_000;
const ROUND_MS = 5 * 60_000;
const DEFAULT_LEAD_MS = 30 * 60_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** Earliest / latest pickup the "Later" picker offers (server re-validates: scheduled.minLeadMs/maxLeadMs). */
export function scheduleBounds(now: Date = new Date()): { min: Date; max: Date } {
  return {
    min: new Date(now.getTime() + WEB_POLICY.booking.scheduleMinLeadMs + SUBMIT_SLACK_MS),
    max: new Date(now.getTime() + WEB_POLICY.booking.scheduleMaxLeadMs),
  };
}

/** Pre-filled pickup when the rider taps "Later": ~30 min out, rounded up to the next 5 minutes. */
export function defaultScheduleTime(now: Date = new Date()): Date {
  const t = now.getTime() + DEFAULT_LEAD_MS;
  return new Date(Math.ceil(t / ROUND_MS) * ROUND_MS);
}

/** `<input type="datetime-local">` value (local wall-clock time, minute precision). */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local `datetime-local` string -> ISO-8601 instant, or null when empty/unparseable. */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value); // no zone suffix => parsed as local time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function leadLabel(ms: number): string {
  return ms % 3_600_000 === 0 ? `${ms / 3_600_000} hours` : `${Math.round(ms / 60_000)} minutes`;
}

/** Null when `iso` is a bookable pickup; otherwise the message to show the rider. */
export function validateSchedule(iso: string | null, now: Date = new Date()): string | null {
  const range = `Pick a time between ${leadLabel(WEB_POLICY.booking.scheduleMinLeadMs)} and ${leadLabel(
    WEB_POLICY.booking.scheduleMaxLeadMs,
  )} from now.`;
  if (!iso) return range;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return range;
  const lead = t - now.getTime();
  if (lead < WEB_POLICY.booking.scheduleMinLeadMs || lead > WEB_POLICY.booking.scheduleMaxLeadMs) {
    return range;
  }
  return null;
}

/** True while a scheduled ride is still waiting for its wake (the server has not started searching yet). */
export function isBeforeWake(scheduledFor: string | null | undefined, now: Date = new Date()): boolean {
  if (!scheduledFor) return false;
  const t = new Date(scheduledFor).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() < t - WEB_POLICY.booking.scheduleWakeLeadMs;
}

/** "Mon 10 Nov, 3:30 PM" in the viewer's locale/time zone. */
export function formatScheduled(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}
