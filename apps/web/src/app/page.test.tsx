import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';

describe('landing page', () => {
  it('names the product and links to booking and sign-in', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading', { name: 'rcab' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book a ride' })).toHaveAttribute('href', '/book');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
  });

  it('no longer claims a hard-coded "Stack status: ok" (the page cannot know)', () => {
    render(<HomePage />);
    expect(screen.queryByText(/Stack status/i)).toBeNull();
    expect(screen.queryByText(/scaffold/i)).toBeNull();
  });
});
