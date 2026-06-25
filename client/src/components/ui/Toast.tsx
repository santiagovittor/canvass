import { useEffect } from 'react';

// Minimal transient toast — fixed bottom-right, warm-dark glass, self-dismiss.
// Slice 0029: a SECONDARY echo of batch completion only; the persistent completion
// card is the primary signal. Render conditionally from a parent that owns the
// message string and clears it via onDismiss. Styling/animation live in globals.css
// (.toast), reduced-motion respected there.
interface ToastProps {
  message: string;
  onDismiss: () => void;
  durationMs?: number;
}

export function Toast({ message, onDismiss, durationMs = 4500 }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [message, onDismiss, durationMs]);

  return (
    <div className="toast" role="status" aria-live="polite" onClick={onDismiss}>
      <span className="toast-dot" />
      <span className="toast-msg">{message}</span>
    </div>
  );
}
