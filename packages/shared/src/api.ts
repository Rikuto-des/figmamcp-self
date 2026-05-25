// Shared types. In embedded mode there are no HTTP contracts — these
// just describe the shape of Figma node JSON returned from the
// figma_get_node_info MCP tool, plus a couple of common enums.

export type ImageFormat = 'png' | 'jpg';
export type RenderScale = 1 | 2 | 3;

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
  // Figma API returns many extra fields (fills, strokes, characters, …)
  // — allow pass-through so this type isn't an obstacle.
  [key: string]: unknown;
}

export interface NodeInfoResponse {
  file_key: string;
  node_id: string;
  node: FigmaNode;
}

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'figma_node_not_found'
  | 'figma_render_failed'
  | 'figma_unauthenticated'
  | 'playwright_timeout'
  | 'internal_error';
