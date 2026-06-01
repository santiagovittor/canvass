export type JobStatus = 'pending' | 'running' | 'enriching' | 'done' | 'error';

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface ScrapeJob {
  id: string;
  searchTerm: string;
  language: string;
  bboxJson: string;
  gridCellKm: number;
  cellCount: number;
  status: JobStatus;
  businessesFound: number;
  enrichmentProgress: number;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface Business {
  id: string;
  jobId: string;
  name: string;
  address?: string;
  phone?: string;
  website?: string;
  hoursJson?: string;
  rating?: number;
  reviewCount?: number;
  category?: string;
  latitude?: number;
  longitude?: number;
  instagram?: string;
  facebook?: string;
  twitter?: string;
  tiktok?: string;
  linkedin?: string;
  youtube?: string;
  emailsJson?: string;
  socialEnriched: number;
  scrapedAt: string;
}

// Keep Result as alias for backward compat within this session
export type Result = Business;

export interface GridCell {
  bounds: [[number, number], [number, number]];
}

export type ExplorerBusiness = Omit<Business, 'emailsJson'> & {
  email: string | null;
  outreachStatus?: string | null;
  outreachNote?: string | null;
};

export interface BusinessQueryFilters {
  search?: string;
  locCountry?: string;
  locState?: string;
  locCity?: string;
  category?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasWebsite?: boolean;
  hasSocial?: boolean;
  minRating?: number;
  orderBy?: 'name' | 'rating' | 'reviewCount' | 'scraped_at';
  orderDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface LocationHierarchyNode {
  country: string;
  count: number;
  states: { state: string; count: number; cities: { city: string; count: number }[] }[];
}

// SSE event payloads
export interface JobStartedEvent { jobId: string; cellCount: number; }
export interface JobProgressEvent { jobId: string; cellsDone: number; jobsDone: number; jobsTotal: number; newBusinesses: number; totalBusinesses: number; }
export interface JobScrapedEvent { jobId: string; count: number; }
export interface JobDoneEvent { jobId: string; }
export interface JobErrorEvent { jobId: string; message: string; }
export interface EnrichProgressEvent { jobId: string; done: number; total: number; }
export interface BusinessesUpdatedEvent { jobId: string; count: number; }
export interface SnapshotActiveEvent { id: string; status: JobStatus; progress: number; businessesFound: number; cellCount: number; }
export interface SnapshotIdleEvent { type: 'idle'; }
export type SnapshotEvent = SnapshotActiveEvent | SnapshotIdleEvent;
