import { useState } from 'react';

interface DisclosureProps {
  label: string;
  /** Active-count badge — shown only when > 0 so hidden active filters stay discoverable. */
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/** Custom progressive-disclosure primitive (slice 0016). No third-party libs.
    Animated open/close via grid-template-rows; respects prefers-reduced-motion
    through the CSS. The count is a data number → JetBrains Mono. */
export function Disclosure({ label, count = 0, defaultOpen = false, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="disclosure">
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="disclosure-chevron" data-open={open} aria-hidden="true">›</span>
        <span className="disclosure-label">{label}</span>
        {count > 0 && <span className="disclosure-badge">{count}</span>}
      </button>
      <div className="disclosure-panel" data-open={open}>
        <div className="disclosure-panel-inner">{children}</div>
      </div>
    </div>
  );
}
