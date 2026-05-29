import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PoolBadge } from './pool-badge';

describe('PoolBadge', () => {
  it('renders nothing when seatCount <= 1', () => {
    const { container } = render(<PoolBadge seatCount={1} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "1 other rider joining" when seatCount=2', () => {
    render(<PoolBadge seatCount={2} />);
    expect(screen.getByTestId('pool-badge')).toHaveTextContent(
      '1 other rider joining — your fare is ready',
    );
  });

  it('renders "2 other riders joining" when seatCount=3', () => {
    render(<PoolBadge seatCount={3} />);
    expect(screen.getByTestId('pool-badge')).toHaveTextContent(
      '2 other riders joining — your fare is ready',
    );
  });
});
