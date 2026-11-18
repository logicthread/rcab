import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { Spinner } from './spinner';

export const buttonStyles = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-semibold transition-[background-color,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none',
  {
    variants: {
      variant: {
        // The one loud button on a screen: the action that moves the ride forward.
        // Filled variants swap to a flat grey (never a faded fill) when disabled, so the label stays legible.
        accent:
          'bg-amber text-amber-ink shadow-lift hover:brightness-95 disabled:bg-line disabled:text-muted disabled:shadow-none disabled:hover:brightness-100',
        primary:
          'bg-ink text-on-ink hover:bg-ink-soft disabled:bg-line disabled:text-muted disabled:hover:bg-line',
        secondary:
          'border border-line-strong bg-surface text-ink hover:bg-paper disabled:text-muted disabled:hover:bg-surface',
        ghost: 'text-ink hover:bg-ink/5 disabled:text-muted disabled:hover:bg-transparent',
        danger:
          'border border-stop/40 bg-surface text-stop hover:bg-stop-wash disabled:border-line disabled:text-muted disabled:hover:bg-surface',
      },
      size: {
        sm: 'min-h-9 px-3 text-sm',
        md: 'min-h-tap px-4 text-[15px]',
        lg: 'min-h-[52px] px-5 text-base',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  /** Shows a spinner and blocks clicks; keep the label so layout doesn't jump. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size,
    block,
    loading = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(buttonStyles({ variant, size, block }), className)}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});
