import type { OutreachLead } from '../../lib/outreachApi';
import { countryFlag } from '../../lib/outreachApi';
import { waLink, telLink, toE164 } from '../../lib/phone';

interface WhatsAppComposerProps {
  lead: OutreachLead | null;
  message: string;
  isGenerating: boolean;
  error: string | null;
  savingState: 'idle' | 'saving' | 'saved';
  onMessageChange: (message: string) => void;
  onGenerate: () => void;
  onMarkContacted: () => void;
}

const PRIMARY_BTN: React.CSSProperties = {
  background: 'var(--accent)',
  color: 'var(--accent-ink)',
  border: 'none',
  borderRadius: 8,
  padding: '8px 16px',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const SECONDARY_BTN: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  padding: '8px 16px',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

export function WhatsAppComposer({
  lead, message, isGenerating, error, savingState,
  onMessageChange, onGenerate, onMarkContacted,
}: WhatsAppComposerProps) {
  if (!lead) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', background: 'var(--bg-base)',
        fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--text-muted)',
      }}>
        Elegí un negocio sin sitio para redactar el mensaje
      </div>
    );
  }

  const wa = waLink(lead.phone, lead.locCountry, message);
  const tel = telLink(lead.phone);
  const e164 = toE164(lead.phone, lead.locCountry);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-base)', overflow: 'hidden',
    }}>
      {/* Header: business identity */}
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {lead.locCountry && <span style={{ fontSize: 15, lineHeight: 1 }}>{countryFlag(lead.locCountry)}</span>}
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
            {lead.name}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' as const }}>
          {lead.category && (
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--accent)' }}>{lead.category}</span>
          )}
          {lead.locNeighbourhood && (
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)' }}>{lead.locNeighbourhood}</span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {lead.phone ?? '—'}
          </span>
        </div>
      </div>

      {/* Body: message editor */}
      <div style={{ flex: 1, minHeight: 0, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Mensaje de WhatsApp
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)', color: 'var(--text-muted)' }}>
            {savingState === 'saving' ? 'guardando…' : savingState === 'saved' ? 'guardado' : ''}
          </span>
        </div>
        <textarea
          value={message}
          onChange={e => onMessageChange(e.target.value)}
          placeholder="Generá o escribí el mensaje de la oferta de sitio web…"
          aria-label="WhatsApp message"
          style={{
            flex: 1, minHeight: 0, resize: 'none' as const,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '12px 14px',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            lineHeight: 1.5,
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
        {error && (
          <div style={{
            fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--error)',
            background: 'var(--error-dim)', borderRadius: 6, padding: '6px 10px',
          }}>
            {error}
          </div>
        )}
        {!e164 && (
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', color: 'var(--warn)' }}>
            Sin número usable — sólo se puede llamar manualmente.
          </div>
        )}
      </div>

      {/* Footer: actions */}
      <div style={{
        padding: '12px 20px', borderTop: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const,
      }}>
        <button
          style={{ ...PRIMARY_BTN, opacity: isGenerating ? 0.4 : 1, cursor: isGenerating ? 'default' : 'pointer' }}
          disabled={isGenerating}
          onClick={onGenerate}
        >
          {isGenerating ? 'Generando…' : message ? 'Regenerar' : 'Generar oferta'}
        </button>
        <a
          href={wa || undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!wa}
          style={{ ...SECONDARY_BTN, opacity: wa ? 1 : 0.4, pointerEvents: wa ? 'auto' : 'none' }}
        >
          WhatsApp
        </a>
        <a
          href={tel || undefined}
          aria-disabled={!tel}
          style={{ ...SECONDARY_BTN, opacity: tel ? 1 : 0.4, pointerEvents: tel ? 'auto' : 'none' }}
        >
          Llamar
        </a>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...SECONDARY_BTN, color: 'var(--success)', borderColor: 'var(--success-border)' }}
          onClick={onMarkContacted}
        >
          Marcar contactado
        </button>
      </div>
    </div>
  );
}
