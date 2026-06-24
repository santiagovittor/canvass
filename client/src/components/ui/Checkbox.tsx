import type { CSSProperties } from 'react';

interface CheckboxProps {
  checked: boolean;
  /** Tri-state: shows a dash instead of a check (e.g. "some rows selected"). */
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}

// Custom checkbox primitive — no third-party UI kit. Token-styled, keyboard
// accessible (Space/Enter toggle via native button), exposes aria-checked
// (mixed when indeterminate). Amber fill when on, dash when indeterminate.
export function Checkbox({ checked, indeterminate = false, onChange, disabled = false, ...rest }: CheckboxProps) {
  const on = checked || indeterminate;
  const box: CSSProperties = {
    width: 18,
    height: 18,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
    background: on ? 'var(--accent)' : 'transparent',
    color: 'var(--accent-ink)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    padding: 0,
    transition: 'background 120ms ease, border-color 120ms ease',
    lineHeight: 1,
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={rest['aria-label']}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={box}
    >
      {indeterminate ? (
        <span style={{ width: 9, height: 2, background: 'var(--accent-ink)', borderRadius: 1 }} aria-hidden="true" />
      ) : checked ? (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.2L4.8 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}
