// HTTP API contracts shared between renderer-worker and mcp-server.
// See docs/specs/api-contracts.md for the full description.

export type ImageFormat = 'png' | 'jpg';
export type RenderScale = 1 | 2 | 3;
export type Classification = 'internal' | 'confidential';
export type Tier = 'A' | 'B' | 'C';
export type RenderedVia = 'cache' | 'playwright';

// ---------- /render ----------

export interface RenderRequest {
  figma_url?: string;
  file_key?: string;
  node_id?: string;
  format?: ImageFormat;
  scale?: RenderScale;
  force_refresh?: boolean;
  classification?: Classification;
}

export interface RenderResponse {
  asset_id: string;
  signed_url: string;
  signed_url_expires_at: string;
  cache_hit: boolean;
  rendered_via: RenderedVia;
  width: number;
  height: number;
  format: ImageFormat;
  scale: RenderScale;
  classification: Classification;
  tier: Tier;
  file_key: string;
  node_id: string;
}

// ---------- /node-info ----------

export interface NodeInfoRequest {
  figma_url?: string;
  file_key?: string;
  node_id?: string;
}

export interface FigmaBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: FigmaBoundingBox;
  children?: FigmaNode[];
  // Figma API は他に fills / strokes / characters など多数返すため、
  // pass-through を許容する。
  [key: string]: unknown;
}

export interface NodeInfoResponse {
  file_key: string;
  node_id: string;
  node: FigmaNode;
}

// ---------- /healthz ----------

export interface HealthzResponse {
  status: 'ok' | 'degraded';
  browser_ready: boolean;
  uptime_sec: number;
  version: string;
}

// ---------- Errors ----------

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'figma_node_not_found'
  | 'figma_render_failed'
  | 'figma_unauthenticated'
  | 'playwright_timeout'
  | 'internal_error';

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}
