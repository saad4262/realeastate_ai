import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: 'primary' | 'ghost';
};

export function Button({ children, variant = 'primary', style, ...props }: ButtonProps) {
  const base: CSSProperties = {
    fontFamily: 'var(--font-sans)',
    fontSize: '0.95rem',
    fontWeight: 600,
    padding: '0.65rem 1.1rem',
    borderRadius: 'var(--radius)',
    border: '1px solid transparent',
    cursor: props.disabled ? 'not-allowed' : 'pointer',
    opacity: props.disabled ? 0.6 : 1,
  };

  const variants: Record<NonNullable<ButtonProps['variant']>, CSSProperties> = {
    primary: {
      background: 'var(--color-accent)',
      color: 'var(--color-accent-fg)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--color-fg)',
      borderColor: 'var(--color-border)',
    },
  };

  return (
    <button type="button" style={{ ...base, ...variants[variant], ...style }} {...props}>
      {children}
    </button>
  );
}
