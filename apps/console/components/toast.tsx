'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import styles from './toast.module.css';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** ms on screen; 0 keeps it until dismissed. Errors default to sticky-ish. */
  duration?: number;
  action?: { label: string; onClick: () => void };
};

type ToastRecord = ToastOptions & {
  id: number;
  variant: ToastVariant;
  leaving: boolean;
};

const VARIANT_ICON: Record<ToastVariant, string> = {
  success: 'check_circle',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  error: 8000,
  warning: 6000,
  info: 5000,
};

const EXIT_MS = 160;

type ToastApi = {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
      );
      const exit = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timers.current.delete(id);
      }, EXIT_MS);
      timers.current.set(id, exit);
    },
    [clearTimer],
  );

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const variant = options.variant ?? 'info';
      const duration = options.duration ?? DEFAULT_DURATION[variant];

      setToasts((prev) => [
        // Three at a time keeps the stack from covering the page.
        ...prev.slice(-2),
        { ...options, id, variant, leaving: false },
      ]);

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.viewport} role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`${styles.toast} ${styles[t.variant]}`}
            data-leaving={t.leaving}
            role={t.variant === 'error' ? 'alert' : 'status'}
            aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
          >
            <span className={styles.icon}>
              <span className={styles.glyph} aria-hidden>
                {VARIANT_ICON[t.variant]}
              </span>
            </span>
            <div className={styles.body}>
              <div className={styles.title}>{t.title}</div>
              {t.description ? (
                <p className={styles.description}>{t.description}</p>
              ) : null}
              {t.action ? (
                <div className={styles.actionRow}>
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => {
                      t.action?.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <span className={styles.glyphSm} aria-hidden>
                close
              </span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
