import { useState } from 'react';
import { Button } from '../ui/Button';
import { exportToSheets } from '../../lib/api';
import type { Business } from '../../types';

function generateCSV(rows: Business[]): string {
  const headers = ['Name', 'Address', 'Phone', 'Website', 'Rating', 'Reviews', 'Category', 'Instagram', 'Facebook', 'Twitter', 'TikTok'];
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([r.name, r.address, r.phone, r.website, r.rating, r.reviewCount, r.category, r.instagram, r.facebook, r.twitter, r.tiktok].map(escape).join(','));
  }
  return lines.join('\n');
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface ExportPanelProps {
  jobId: string;
  results: Business[];
}

export function ExportPanel({ jobId, results }: ExportPanelProps) {
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const handleCsvExport = () => {
    const csv = generateCSV(results);
    downloadFile(csv, `scrape-${jobId}.csv`, 'text/csv');
  };

  const handleSheetsExport = async () => {
    setExporting(true);
    setExportMsg(null);
    try {
      const { rowsExported } = await exportToSheets();
      setExportMsg({ ok: true, text: `Exported ${rowsExported} rows` });
    } catch (err) {
      setExportMsg({ ok: false, text: err instanceof Error ? err.message : 'Export failed' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-muted)', flex: 1 }}>
          {results.length} results
        </span>
        <Button variant="secondary" onClick={handleCsvExport} style={{ fontSize: '12px', padding: '7px 12px' }}>
          Export CSV
        </Button>
        <Button
          variant="primary"
          onClick={handleSheetsExport}
          disabled={exporting || results.length === 0}
          style={{ fontSize: '12px', padding: '7px 12px' }}
        >
          {exporting ? '…' : 'Export to Sheets'}
        </Button>
      </div>
      {exportMsg && (
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: exportMsg.ok ? 'var(--success)' : 'var(--error)',
          textAlign: 'right',
        }}>
          {exportMsg.text}
        </span>
      )}
    </div>
  );
}
