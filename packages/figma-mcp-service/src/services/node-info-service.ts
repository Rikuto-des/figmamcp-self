import type { NodeInfoResponse } from '@figma-mcp-poc/shared';
import { FigmaApiError, getNodeInfo } from '../figma-rest.js';
import { appendAuditLog } from '../supabase.js';
import { normalizeNodeId, parseFigmaUrl } from '../url-parser.js';

export interface NodeInfoForUserInput {
  userId: string;
  figmaUrl?: string;
  fileKey?: string;
  nodeId?: string;
}

export class NodeInfoError extends Error {
  constructor(public code: string, public httpStatus: number, message: string) {
    super(message);
    this.name = 'NodeInfoError';
  }
}

export async function nodeInfoForUser(input: NodeInfoForUserInput): Promise<NodeInfoResponse> {
  let fileKey: string;
  let nodeId: string;
  if (input.figmaUrl) {
    const target = parseFigmaUrl(input.figmaUrl);
    if (!target?.nodeId) {
      throw new NodeInfoError('invalid_request', 400, 'failed to parse figma_url');
    }
    fileKey = target.fileKey;
    nodeId = target.nodeId;
  } else if (input.fileKey && input.nodeId) {
    fileKey = input.fileKey;
    nodeId = normalizeNodeId(input.nodeId);
  } else {
    throw new NodeInfoError('invalid_request', 400, 'figma_url or (file_key + node_id) required');
  }

  await appendAuditLog({
    userId: input.userId,
    event: 'node_info.requested',
    meta: { fileKey, nodeId },
  });

  try {
    const node = await getNodeInfo(fileKey, nodeId);
    await appendAuditLog({
      userId: input.userId,
      event: 'node_info.completed',
      meta: { fileKey, nodeId },
    });
    return { file_key: fileKey, node_id: nodeId, node };
  } catch (err) {
    if (err instanceof FigmaApiError) {
      const map = { figma_node_not_found: 404, unauthorized: 401, internal_error: 500 } as const;
      throw new NodeInfoError(err.code, map[err.code], err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new NodeInfoError('internal_error', 500, msg);
  }
}
