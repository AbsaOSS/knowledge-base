// How tool handlers turn facade results and failures into MCP tool results.
import { UserFacingError } from '../domain.ts';

/** Every tool is a read-only, idempotent lookup over a closed search index. */
export const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false };

export interface ResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

/** The value as structured content, plus the same JSON as text for clients that ignore it. */
export function toolResult(value: object, links: ResourceLink[] = []) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }, ...links],
    // The SDK types structured content as a plain record; the output schema checks the shape.
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * A failure as a tool error. Input mistakes say what was wrong; anything else is logged
 * and answered generically, so internals never reach the client.
 */
export function toolError(error: unknown) {
  if (error instanceof UserFacingError)
    return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
  process.stderr.write('kb-mcp tool failure\n');
  return {
    isError: true,
    content: [{ type: 'text' as const, text: 'Unable to complete request. Retry with valid documented inputs.' }],
  };
}
