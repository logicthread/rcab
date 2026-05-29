import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RideTypeToggle } from './ride-type-toggle';

describe('RideTypeToggle', () => {
  it('marks the Share option as selected when value=shared', () => {
    render(<RideTypeToggle value="shared" onChange={() => undefined} />);
    const share = screen.getByRole('radio', { name: 'Share' });
    const priv = screen.getByRole('radio', { name: 'Private' });
    expect(share).toHaveAttribute('aria-checked', 'true');
    expect(priv).toHaveAttribute('aria-checked', 'false');
  });

  it('marks the Private option as selected when value=private', () => {
    render(<RideTypeToggle value="private" onChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Share' })).toHaveAttribute('aria-checked', 'false');
  });

  it('fires onChange with the opposite type when the user clicks Private', async () => {
    const onChange = vi.fn();
    render(<RideTypeToggle value="shared" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Private' }));
    expect(onChange).toHaveBeenCalledWith('private');
  });

  it('respects the disabled flag — buttons are disabled and clicks are no-ops', async () => {
    const onChange = vi.fn();
    render(<RideTypeToggle value="shared" onChange={onChange} disabled />);
    const share = screen.getByRole('radio', { name: 'Share' });
    expect(share).toBeDisabled();
    await userEvent.click(share);
    expect(onChange).not.toHaveBeenCalled();
  });
});
