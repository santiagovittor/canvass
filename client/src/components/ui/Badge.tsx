import type { JobStatus } from '../../types';

const labels: Record<JobStatus, string> = {
  pending: 'Pending',
  running: 'Scraping',
  enriching: 'Enriching',
  done: 'Done',
  error: 'Error',
};

export function Badge({ status }: { status: JobStatus }) {
  return (
    <span className={`pill pill--${status}`}>
      <span className="pill-dot" />
      {labels[status]}
    </span>
  );
}
