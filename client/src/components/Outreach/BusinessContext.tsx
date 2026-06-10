import { MapContainer, TileLayer } from 'react-leaflet';
import type { OutreachLead, WebsiteAnalysis } from '../../lib/outreachApi';
import { countryFlag } from '../../lib/outreachApi';

const BOOKABLE_CATS = /salón|salon|gym|gimnasio|clínica|clinica|restaurant|spa|peluquería|peluqueria|consultorio|dentist|fitness|studio|pilates|yoga|médico|medico/i;
const FOOD_CATS = /restaurant|café|cafe|bar|comida|panadería|panaderia|heladería|heladeria|pizzería|pizzeria|delivery|cocina|sushi|burger|parrilla/i;

interface BusinessContextProps {
  lead: OutreachLead | null;
  analysis?: WebsiteAnalysis | null;
  onMarkReplied?: () => void;
}

function normalizeWebsite(raw: string | null): string {
  if (!raw) return '';
  return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
}

function StarRating({ rating }: { rating: number | null }) {
  if (rating === null) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} style={{
          color: i <= Math.round(rating) ? 'var(--accent)' : 'var(--border-strong)',
          fontSize: 14,
          lineHeight: 1,
        }}>★</span>
      ))}
    </div>
  );
}

function SocialIcons({ lead }: { lead: OutreachLead }) {
  const socials = [
    { key: 'instagram', url: lead.instagram, icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
      </svg>
    )},
    { key: 'facebook', url: lead.facebook, icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
      </svg>
    )},
    { key: 'twitter', url: lead.twitter, icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
    )},
    { key: 'tiktok', url: lead.tiktok, icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
        <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.19 8.19 0 004.78 1.52V6.78a4.85 4.85 0 01-1.01-.09z"/>
      </svg>
    )},
    { key: 'linkedin', url: lead.linkedin, icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
      </svg>
    )},
    { key: 'youtube', url: lead.youtube, icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
        <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
      </svg>
    )},
  ].filter(s => s.url);

  if (socials.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
      {socials.map(s => (
        <span key={s.key} style={{ color: 'var(--accent)' }} title={s.key}>
          {s.icon}
        </span>
      ))}
    </div>
  );
}

export function BusinessContext({ lead, analysis, onMarkReplied }: BusinessContextProps) {
  if (!lead) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--border)',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
      }}>
        No lead selected
      </div>
    );
  }

  const domain = normalizeWebsite(lead.website);
  const flag = countryFlag(lead.locCountry);

  return (
    <div style={{
      background: 'var(--bg-panel)',
      borderLeft: '1px solid var(--border)',
      padding: '16px',
      overflowY: 'auto' as const,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 12,
    }}>
      {/* Name + flag */}
      <div>
        <div style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--text-primary)',
          lineHeight: 1.3,
        }}>
          {flag && <span style={{ marginRight: 6 }}>{flag}</span>}
          {lead.name}
        </div>
      </div>

      {onMarkReplied && (
        <button
          className="btn-secondary"
          onClick={onMarkReplied}
          style={{ color: 'var(--success)', fontSize: 12 }}
        >
          Marcar respondido ✓
        </button>
      )}

      {/* Rating + review count */}
      {lead.rating !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StarRating rating={lead.rating} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
            {lead.rating.toFixed(1)}
          </span>
          {lead.reviewCount !== null && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
              ({lead.reviewCount})
            </span>
          )}
        </div>
      )}

      {/* Category pill */}
      {lead.category && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          background: 'var(--accent-dim)',
          color: 'var(--accent)',
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase' as const,
          padding: '3px 10px',
          borderRadius: 100,
          alignSelf: 'flex-start',
        }}>
          {lead.category}
        </span>
      )}

      {/* Location */}
      {(lead.locNeighbourhood || lead.locCity) && (
        <div style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}>
          {[lead.locNeighbourhood, lead.locCity].filter(Boolean).join(' · ')}
        </div>
      )}

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--border)' }} />

      {/* Website badge */}
      <div>
        <div style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          marginBottom: 6,
        }}>
          Website
        </div>
        {domain ? (
          <span style={{
            display: 'inline-block',
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            padding: '3px 8px',
            borderRadius: 6,
            wordBreak: 'break-all' as const,
          }}>
            {domain}
          </span>
        ) : (
          <span style={{
            display: 'inline-block',
            background: 'rgba(245,183,0,0.1)',
            color: 'var(--warn)',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            padding: '3px 8px',
            borderRadius: 6,
          }}>
            No website
          </span>
        )}
      </div>

      {/* Website analysis chips */}
      {analysis?.loadedSuccessfully && (() => {
        const cat = lead.category ?? '';
        const isBookable = BOOKABLE_CATS.test(cat);
        const isFood = FOOD_CATS.test(cat);
        const chips: { label: string; present: boolean }[] = [
          { label: analysis.hasSSL ? 'SSL ✓' : 'No SSL', present: analysis.hasSSL },
          { label: analysis.hasViewportMeta ? 'Mobile ✓' : 'No mobile', present: analysis.hasViewportMeta },
          { label: analysis.hasContactForm ? 'Form ✓' : 'No form', present: analysis.hasContactForm },
          { label: analysis.hasWhatsappLink ? 'WhatsApp ✓' : 'No WhatsApp', present: analysis.hasWhatsappLink },
          ...(isBookable ? [{ label: analysis.hasOnlineBooking ? 'Booking ✓' : 'No booking', present: analysis.hasOnlineBooking }] : []),
          ...(isFood ? [{ label: analysis.hasMenuOrServices ? 'Menu ✓' : 'No menu', present: analysis.hasMenuOrServices }] : []),
        ];
        return (
          <>
            <style>{`@keyframes chipFade { from { opacity: 0; } to { opacity: 1; } }`}</style>
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4, animation: 'chipFade 200ms ease forwards' }}>
              {chips.map((chip, i) => (
                <span key={i} style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 10,
                  fontWeight: 500,
                  padding: '2px 7px',
                  borderRadius: 100,
                  background: chip.present ? 'rgba(0,229,204,0.1)' : 'rgba(245,183,0,0.12)',
                  color: chip.present ? 'var(--accent)' : 'var(--warn)',
                }}>
                  {chip.label}
                </span>
              ))}
            </div>
          </>
        );
      })()}

      {/* Phone */}
      {lead.phone && (
        <div style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}>
          📞 {lead.phone}
        </div>
      )}

      {/* Social icons */}
      <SocialIcons lead={lead} />

      {/* Minimap */}
      {lead.latitude !== null && lead.longitude !== null && (
        <div style={{
          position: 'relative',
          height: 120,
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--border)',
          marginTop: 4,
          flexShrink: 0,
        }}>
          <MapContainer
            center={[lead.latitude, lead.longitude]}
            zoom={15}
            style={{ height: '100%', width: '100%' }}
            zoomControl={false}
            dragging={false}
            scrollWheelZoom={false}
            doubleClickZoom={false}
            keyboard={false}
            touchZoom={false}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              subdomains="abcd"
              maxZoom={20}
            />
          </MapContainer>
          {/* Pin overlay at center — avoids L.Marker default icon issue */}
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -100%)',
            zIndex: 1000,
            pointerEvents: 'none',
          }}>
            <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
              <path
                d="M8 0C3.6 0 0 3.6 0 8c0 5.4 8 12 8 12s8-6.6 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z"
                fill="var(--accent)"
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
