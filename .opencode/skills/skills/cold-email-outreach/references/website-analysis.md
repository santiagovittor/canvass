# Website Analysis — Type & Signal Mapping

## WebsiteAnalysis type (canonical)

```typescript
interface WebsiteAnalysis {
  loadedSuccessfully: boolean;
  hasViewportMeta: boolean;
  hasContactForm: boolean;
  hasOnlineBooking: boolean;
  hasWhatsappLink: boolean;
  hasSSL: boolean;
  pageTitle: string | null;
  metaDescription: string | null;
  hasMenuOrServices: boolean;
  finalUrl: string | null;
  error?: string;
}
```

## Signal → pitch mapping

Build `analysisContext` string from gaps only. Pick the SINGLE most relevant
signal for the business category. Inject after `{{OFFER_CONTEXT}}`.

**Priority order** (top = highest priority for that context):

| Signal false | AR pitch fragment | EN pitch fragment | Category gate |
|---|---|---|---|
| `hasOnlineBooking` | "no tiene sistema de turnos online" | "no online booking" | salón, gym, clínica, restaurant |
| `hasMenuOrServices` | "no tiene carta ni lista de servicios" | "no menu or services list" | food, restaurant, café |
| `hasViewportMeta` | "el sitio no está optimizado para móviles" | "not mobile-optimized" | any |
| `hasWhatsappLink` | "no tiene botón de WhatsApp" | — (skip for non-AR) | AR only |
| `hasContactForm` | "no tiene formulario de contacto" | "no contact form" | any |
| `hasSSL` | "corre en HTTP sin certificado" | "no SSL certificate" | any |

**When signal is true** (notable, use as hook):
- `hasWhatsappLink` → acknowledge, pivot to what's still missing

**Never** list multiple gaps. Never mention `pageTitle` or `metaDescription` in email.

## Fallback

`loadedSuccessfully: false` → silently use offer branch case 2 (website present,
no analysis). Never mention fetch failure in the email. Log server-side only.