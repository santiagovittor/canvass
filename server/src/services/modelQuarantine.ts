import { getNumber } from './appSettings';

// In-process primary-model 5xx quarantine (slice 0026, extracted from geminiComposer so
// the verifier reuses the exact same behavior). After QUARANTINE_STRIKES consecutive 5xx
// from the same model within QUARANTINE_WINDOW_MS, skip it for `getNumber(minutesKey)`
// minutes and let the caller route to its fallback instead of re-storming every item.

const QUARANTINE_STRIKES = 2;
const QUARANTINE_WINDOW_MS = 5 * 60_000;

export interface ModelQuarantine {
  record5xx(modelId: string): void;
  recordSuccess(): void;
  isQuarantined(): boolean;
}

// `minutesKey` is the settings key holding the quarantine duration (e.g.
// 'COMPOSE_503_QUARANTINE_MINUTES'); read live so a Settings change applies without restart.
export function createQuarantine(minutesKey: string, logLabel: string): ModelQuarantine {
  let strikes: { modelId: string; at: number }[] = [];
  let quarantinedUntil = 0;
  let lastModelId = '';

  return {
    record5xx(modelId: string): void {
      const now = Date.now();
      lastModelId = modelId;
      strikes.push({ modelId, at: now });
      strikes = strikes.filter(s => now - s.at < QUARANTINE_WINDOW_MS);
      const recent = strikes.filter(s => s.modelId === modelId);
      if (recent.length >= QUARANTINE_STRIKES) {
        quarantinedUntil = now + getNumber(minutesKey) * 60_000;
        console.warn(
          `[gemini] ${logLabel} primary quarantined model=${modelId} until=${new Date(quarantinedUntil).toISOString()} reason=${recent.length}x 5xx in ${QUARANTINE_WINDOW_MS / 60_000}m`,
        );
      }
    },
    recordSuccess(): void {
      if (quarantinedUntil > 0) {
        console.warn(`[gemini] ${logLabel} primary quarantine cleared model=${lastModelId}`);
      }
      strikes = [];
      quarantinedUntil = 0;
    },
    isQuarantined(): boolean {
      return Date.now() < quarantinedUntil;
    },
  };
}
