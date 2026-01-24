import { invoke } from '@tauri-apps/api/tauri';

export interface ToolParameter {
  name: string;
  param_type: string;
  description: string;
  required: boolean;
}

export interface DiscoveredTool {
  name: string;
  description: string;
  file_path: string;
  line_number: number;
  tool_type: 'decorator' | 'spec' | 'builtin';
  parameters: ToolParameter[];
}

export interface DiscoveredAgent {
  name: string;
  system_prompt: string | null;
  file_path: string;
  line_number: number;
  tools: string[];
}

export interface DiscoveredHandler {
  name: string;
  file_path: string;
  line_number: number;
  handler_type: 'lambda' | 'api' | 'entrypoint' | 'graph';
}

export interface ProjectDiscovery {
  tools: DiscoveredTool[];
  agents: DiscoveredAgent[];
  handlers: DiscoveredHandler[];
}

export async function scanProjectForStrands(directory: string): Promise<ProjectDiscovery> {
  try {
    const result = await invoke<ProjectDiscovery>('scan_project_for_strands', { directory });
    return result;
  } catch (error) {
    console.error('Failed to scan project:', error);
    throw error;
  }
}

export function getRelativePath(fullPath: string, basePath: string): string {
  if (fullPath.startsWith(basePath)) {
    return fullPath.slice(basePath.length).replace(/^\//, '');
  }
  return fullPath;
}

export function groupToolsByFile(tools: DiscoveredTool[]): Map<string, DiscoveredTool[]> {
  const grouped = new Map<string, DiscoveredTool[]>();
  for (const tool of tools) {
    const existing = grouped.get(tool.file_path) || [];
    existing.push(tool);
    grouped.set(tool.file_path, existing);
  }
  return grouped;
}

export function groupHandlersByFile(handlers: DiscoveredHandler[]): Map<string, DiscoveredHandler[]> {
  const grouped = new Map<string, DiscoveredHandler[]>();
  for (const handler of handlers) {
    const existing = grouped.get(handler.file_path) || [];
    existing.push(handler);
    grouped.set(handler.file_path, existing);
  }
  return grouped;
}
