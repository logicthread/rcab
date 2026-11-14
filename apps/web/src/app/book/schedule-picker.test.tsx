import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SchedulePicker } from './schedule-picker';

describe('SchedulePicker', () => {
  it('"Later" pre-fills a time ~30 min out; "Now" clears it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SchedulePicker value={null} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Now' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('schedule-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('schedule-later'));
    const iso = onChange.mock.calls[0][0] as string;
    const lead = new Date(iso).getTime() - Date.now();
    expect(lead).toBeGreaterThanOrEqual(29 * 60_000);
    expect(lead).toBeLessThan(36 * 60_000);

    rerender(<SchedulePicker value={iso} onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Later' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('schedule-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('schedule-now'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('typing a new time reports an ISO instant; an out-of-window time shows the range error', () => {
    const onChange = vi.fn();
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    render(<SchedulePicker value={soon} onChange={onChange} />);
    expect(screen.getByTestId('schedule-error')).toHaveTextContent(/between 15 minutes and 24 hours/);

    fireEvent.change(screen.getByTestId('schedule-input'), { target: { value: '2030-01-01T10:00' } });
    expect(onChange).toHaveBeenCalledWith(new Date(2030, 0, 1, 10, 0).toISOString());
  });

  it('a valid time shows no error', () => {
    const ok = new Date(Date.now() + 90 * 60_000).toISOString();
    render(<SchedulePicker value={ok} onChange={() => undefined} />);
    expect(screen.queryByTestId('schedule-error')).not.toBeInTheDocument();
  });
});
