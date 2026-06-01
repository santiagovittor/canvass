import { google } from 'googleapis';
import fs from 'fs';
import { db, queryBusinesses, BusinessFilters } from '../db';
import { businesses } from '../db/schema';
import { env } from '../env';

const HEADERS = [
  'Name', 'Category', 'Address', 'Phone', 'Email', 'Website',
  'Instagram', 'Facebook', 'LinkedIn', 'Rating', 'Review Count',
  'Place ID', 'Scraped At',
];

// Place ID is column L (index 11, zero-based)
const PLACE_ID_COL = 'L';

function getAuth() {
  if (!fs.existsSync(env.GOOGLE_SERVICE_ACCOUNT_PATH)) {
    throw new Error(
      `Google service account file not found at ${env.GOOGLE_SERVICE_ACCOUNT_PATH}`,
    );
  }
  return new google.auth.GoogleAuth({
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export function parseEmails(emailsJson: string | null): string[] {
  if (!emailsJson) return [];
  try {
    const arr = JSON.parse(emailsJson);
    if (typeof arr === 'string') return arr ? [arr] : [];
    return Array.isArray(arr) ? (arr as string[]).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function bizToRow(b: typeof businesses.$inferSelect): (string | number | null)[] {
  return [
    b.name,
    b.category ?? null,
    b.address ?? null,
    b.phone ?? null,
    parseEmails(b.emailsJson).join(', ') || null,
    b.website ?? null,
    b.instagram ?? null,
    b.facebook ?? null,
    b.linkedin ?? null,
    b.rating ?? null,
    b.reviewCount ?? null,
    b.id,
    b.scrapedAt,
  ];
}

async function appendNewRows(sourceRows: (typeof businesses.$inferSelect)[]): Promise<number> {
  if (!env.GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID is not configured. Set it in .env.');
  }
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sheet1!A1:A1',
  });
  const hasHeaders = headerRes.data.values?.[0]?.[0] === 'Name';

  const placeIdRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `Sheet1!${PLACE_ID_COL}:${PLACE_ID_COL}`,
  });
  const existingIds = new Set<string>(
    (placeIdRes.data.values ?? [])
      .flat()
      .filter((v): v is string => typeof v === 'string' && v !== 'Place ID'),
  );

  const newRows = sourceRows.filter(b => !existingIds.has(b.id));

  if (!hasHeaders) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetId = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        }],
      },
    });
  }

  if (newRows.length === 0) return 0;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    requestBody: { values: newRows.map(bizToRow) },
  });

  console.log(`[sheets] exported ${newRows.length} rows to sheet ${spreadsheetId}`);
  return newRows.length;
}

export function buildTabName(filters: BusinessFilters, count: number): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dateStr = `${now.getDate()} ${months[now.getMonth()]} ${hh}:${mm}`;

  const parts: string[] = [];
  if (filters.locCountry) parts.push(filters.locCountry);
  if (filters.locState)   parts.push(filters.locState);
  if (filters.locCity)    parts.push(filters.locCity);
  if (filters.category)   parts.push(filters.category);
  if (filters.hasEmail)   parts.push('email');
  if (filters.hasWebsite) parts.push('web');
  if (filters.minRating)  parts.push(`rating ${filters.minRating}+`);

  let name: string;
  if (parts.length === 0) {
    name = `All leads · ${count} · ${dateStr}`;
  } else {
    parts.push(`${count} leads`);
    parts.push(dateStr);
    name = parts.join(' · ');
  }

  if (name.length > 75) name = name.slice(0, 74) + '…';
  return name;
}

export async function createExportTab(
  tabName: string,
  headers: string[],
  rows: (string | number | null)[][],
): Promise<{ url: string; sheetId: number }> {
  if (!env.GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID is not configured. Set it in .env.');
  }
  const spreadsheetId = env.GOOGLE_SHEET_ID;
  const auth = getAuth();
  const sheetsApi = google.sheets({ version: 'v4', auth });

  const addRes = await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  const newSheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (newSheetId == null) throw new Error('Failed to create sheet tab');

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers, ...rows] },
  });

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          repeatCell: {
            range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
      ],
    },
  });

  return {
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${newSheetId}`,
    sheetId: newSheetId,
  };
}

export async function exportToSheets(): Promise<number> {
  const allRows = db.select().from(businesses).all();
  return appendNewRows(allRows);
}

export async function exportFilteredToSheets(filters: BusinessFilters): Promise<number> {
  const { rows } = queryBusinesses({ ...filters, page: 1, pageSize: 10000 });
  return appendNewRows(rows);
}
