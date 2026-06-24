import { useState, useEffect, useCallback } from 'react';
import { useSSE } from './useSSE';
import {
  listScheduled, getScheduledQueueStatus, cancelScheduled, rescheduleScheduled,
  cancelAllPending, pauseScheduler, resumeScheduler, baLocalToUtcIso,
  type ScheduledSend, type ScheduledQueueStatus,
} from '../lib/outreachApi';

// Owns the scheduled-send queue for the Automate Send lane. One-shot fetch on
// mount, refreshed on the existing `send-scheduler:tick` SSE (event-driven, not a
// poll). Mutations call the API then refresh.
export function useScheduledSends() {
  const [rows, setRows] = useState<ScheduledSend[]>([]);
  const [status, setStatus] = useState<ScheduledQueueStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    listScheduled().then(setRows).catch(() => {});
    getScheduledQueueStatus().then(setStatus).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Live: the tick payload IS the queue status; refresh the row list alongside it.
  useSSE({
    'send-scheduler:tick': (data: unknown) => {
      setStatus(data as ScheduledQueueStatus);
      listScheduled().then(setRows).catch(() => {});
    },
  });

  const cancel = useCallback(async (id: string) => { await cancelScheduled(id); refresh(); }, [refresh]);
  const reschedule = useCallback(async (id: string, localDateTime: string) => {
    await rescheduleScheduled(id, baLocalToUtcIso(localDateTime));
    refresh();
  }, [refresh]);
  const cancelAll = useCallback(async () => { await cancelAllPending(); refresh(); }, [refresh]);
  const pause = useCallback(async (reason?: string) => { await pauseScheduler(reason); refresh(); }, [refresh]);
  const resume = useCallback(async () => { await resumeScheduler(); refresh(); }, [refresh]);

  return { rows, status, loading, refresh, cancel, reschedule, cancelAll, pause, resume };
}
