import { useGeminiHealth } from '../hooks/useGeminiHealth';

// Always-on Gemini health chip (slice 0020). Answers the operator's three questions at
// a glance: is everything fine, am I about to run out of daily budget, and did Gemini
// fail (and is the app handling it). Non-technical copy — no status codes or stack
// traces. Lives under the active-runs strip so it is visible regardless of tab.
const MESSAGE: Record<string, string> = {
  healthy: 'Healthy — emails generating normally',
  low: 'Daily budget almost used — top up soon (resets at midnight PT)',
};

export function GeminiHealthBanner() {
  const h = useGeminiHealth();

  const message =
    h.status === 'exhausted'
      ? h.provider.exhausted
        ? 'Quota reached — preparing emails is paused, resumes automatically when quota frees up'
        : 'Daily budget reached — preparing emails is paused, resumes at midnight PT'
      : MESSAGE[h.status];

  return (
    <div className={`gemini-health gemini-health--${h.status}`}>
      <span className="gemini-health-dot" />
      <span className="gemini-health-label">Gemini</span>
      <span className="gemini-health-msg">{message}</span>
      {h.rpdCeiling > 0 && (
        <span className="gemini-health-num">
          {h.rpdCount}/{h.rpdCeiling}
        </span>
      )}
    </div>
  );
}
