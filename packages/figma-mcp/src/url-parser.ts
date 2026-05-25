// Figma URL parser. See docs/reference/figma-url-formats.md.

export interface ParsedFigmaUrl {
  fileKey: string;
  nodeId: string | null;
}

const KIND_PATTERN = /^\/(design|file|proto|board|slides|community\/file)\/([A-Za-z0-9]+)/;

export function parseFigmaUrl(input: string): ParsedFigmaUrl | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;

  const match = url.pathname.match(KIND_PATTERN);
  if (!match) return null;

  const fileKey = match[2]!;
  const rawNodeId = url.searchParams.get('node-id');
  const nodeId = rawNodeId ? normalizeNodeId(rawNodeId) : null;

  return { fileKey, nodeId };
}

export function normalizeNodeId(raw: string): string {
  // URL form `1-23` → internal form `1:23`
  return raw.replace(/-/g, ':');
}

export function nodeIdToUrlForm(nodeId: string): string {
  return nodeId.replace(/:/g, '-');
}
