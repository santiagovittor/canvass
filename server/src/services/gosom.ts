import { request } from 'undici';
import { env } from '../env';

export interface GosomJobParams {
  jobId: string;
  keywords: string[];
  lang: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  email: boolean;
}

export interface GosomJobStatus {
  ID: string;
  Name: string;
  Status: string;
  Date?: string;
}

let warned404 = false;
function warn404() {
  if (!warned404) {
    console.warn('WARN: Gosom returned 404. Verify gosom REST API shape at http://localhost:8080/api/docs — endpoint paths may have changed.');
    warned404 = true;
  }
}

async function gosomRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${env.GOSOM_URL}${path}`;
  const { statusCode, body: resBody } = await request(url, {
    method: method as 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (statusCode === 404) {
    warn404();
    throw new Error(`Gosom 404: ${path}`);
  }
  if (statusCode >= 400) {
    const text = await resBody.text();
    throw new Error(`Gosom ${statusCode}: ${text}`);
  }

  return resBody.json() as Promise<T>;
}

export async function createJob(params: GosomJobParams): Promise<string> {
  const body = {
    name: params.jobId,
    keywords: params.keywords,
    lang: params.lang,
    lat: String(params.latitude),
    lon: String(params.longitude),
    radius: Math.round(params.radiusMeters),
    zoom: 15,
    depth: 5,
    email: params.email,
    max_time: 3600,
  };
  console.log('[gosom] createJob body:', JSON.stringify(body));
  const result = await gosomRequest<{ id: string }>('POST', '/api/v1/jobs', body);
  return result.id;
}

export async function getJob(id: string): Promise<GosomJobStatus> {
  return gosomRequest<GosomJobStatus>('GET', `/api/v1/jobs/${id}`);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (line[i] === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += line[i];
    }
  }
  result.push(current);
  return result;
}

export async function downloadResults(id: string): Promise<Record<string, unknown>[]> {
  const url = `${env.GOSOM_URL}/api/v1/jobs/${id}/download`;
  const { statusCode, body: resBody } = await request(url, { method: 'GET' });

  if (statusCode === 404) {
    warn404();
    throw new Error(`Gosom 404: /api/v1/jobs/${id}/download`);
  }
  if (statusCode >= 400) {
    const text = await resBody.text();
    throw new Error(`Gosom ${statusCode}: ${text}`);
  }

  const raw = await resBody.text();
  console.log('[gosom] downloadResults statusCode:', statusCode, 'raw length:', raw.length, 'first 300:', raw.substring(0, 300));

  // Try JSON first
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(raw) as Record<string, unknown>[];
    if (parsed.length === 0) throw new Error(`gosom returned no parseable results for job ${id}`);
    return parsed;
  }

  // Parse CSV
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error(`gosom returned no parseable results for job ${id}`);
  const headers = parseCsvLine(lines[0]);
  console.log('[gosom] CSV headers:', headers);
  const rows = lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => { obj[h.trim()] = values[i] ?? null; });
    return obj;
  });
  if (rows.length === 0) throw new Error(`gosom returned no parseable results for job ${id}`);
  return rows;
}

export async function cancelJob(id: string): Promise<void> {
  const { statusCode, body } = await request(`${env.GOSOM_URL}/api/v1/jobs/${id}`, {
    method: 'DELETE',
  });
  if (statusCode === 404) warn404();
  await body.dump();
}
