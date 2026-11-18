import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { MenuDrawer } from './menu-drawer';

function renderMenu(onSignOut = vi.fn()) {
  render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <MenuDrawer account="rider@gmail.com" onSignOut={onSignOut} />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByTestId('menu-open'));
  return onSignOut;
}

describe('MenuDrawer', () => {
  it('is closed until the menu button is pressed', () => {
    render(<MenuDrawer account="rider@gmail.com" onSignOut={vi.fn()} />);
    expect(screen.queryByTestId('menu-drawer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByTestId('menu-drawer')).toBeInTheDocument();
  });

  it('offers profile, ride history, feedback, help, theme and sign out', async () => {
    renderMenu();
    expect(await screen.findByText('Signed in as rider@gmail.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ride history' })).toHaveAttribute('href', '/history');
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('link', { name: 'Give feedback' })).toHaveAttribute(
      'href',
      '/feedback',
    );
    expect(screen.getByRole('link', { name: 'Contact help' })).toHaveAttribute('href', '/help');
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('signs out and closes the menu', async () => {
    const onSignOut = renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('switches the theme and marks the choice', async () => {
    renderMenu();
    const dark = await screen.findByTestId('theme-dark');
    fireEvent.click(dark);
    expect(await screen.findByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    fireEvent.click(screen.getByTestId('theme-light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
