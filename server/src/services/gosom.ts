import { request, Client } from 'undici';
import { env } from '../env';

export interface GosomJobParams {
  jobId: string;
  keywords: string[];
  lang: string;
  latitude?: number;     // omit for global keyword jobs
  longitude?: number;
  radiusMeters?: number;
  email: boolean;
  depth?: number;        // default 5
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
  const body: Record<string, unknown> = {
    name: params.jobId,
    keywords: params.keywords,
    lang: params.lang,
    zoom: 15,
    depth: params.depth ?? 5,
    email: params.email,
    max_time: 900,
  };
  if (params.latitude != null && params.longitude != null && params.radiusMeters != null) {
    body.lat = String(params.latitude);
    body.lon = String(params.longitude);
    body.radius = Math.round(params.radiusMeters);
  }
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

  // Try JSON first. An empty array is a legitimate result — a category with
  // no businesses in the cell — not an error.
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return JSON.parse(raw) as Record<string, unknown>[];
  }

  // Parse CSV. A header-only CSV is likewise a legitimate empty result;
  // only a body with no recognizable header is treated as unparseable.
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0 || !lines[0].includes(',')) {
    throw new Error(`gosom returned no parseable results for job ${id}`);
  }
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => { obj[h.trim()] = values[i] ?? null; });
    return obj;
  });
}

// gosom's web runner has a known bug (gosom/google-maps-scraper#143): it
// randomly dies after finishing a batch — the job stays "working" forever and
// pending jobs are never picked. -exit-on-inactivity doesn't fire in this
// state, so the only cure is restarting the container. Best-effort: requires
// the docker socket mounted into this container; failures are logged and
// swallowed (the poll loop's timeout still bounds the damage).
export async function restartContainer(): Promise<boolean> {
  const docker = new Client('http://localhost', { socketPath: env.DOCKER_SOCK });
  try {
    const { statusCode, body } = await docker.request({
      path: `/containers/${env.GOSOM_CONTAINER}/restart?t=5`,
      method: 'POST',
    });
    await body.dump();
    if (statusCode === 204) {
      console.warn(`[gosom] restarted container ${env.GOSOM_CONTAINER}`);
      return true;
    }
    console.warn(`[gosom] container restart returned HTTP ${statusCode}`);
    return false;
  } catch (err) {
    console.warn('[gosom] container restart failed (docker socket mounted?):', err instanceof Error ? err.message : err);
    return false;
  } finally {
    await docker.close().catch(() => {});
  }
}

export async function cancelJob(id: string): Promise<void> {
  const { statusCode, body } = await request(`${env.GOSOM_URL}/api/v1/jobs/${id}`, {
    method: 'DELETE',
  });
  if (statusCode === 404) warn404();
  await body.dump();
}
