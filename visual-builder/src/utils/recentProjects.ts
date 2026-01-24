const STORAGE_KEY = 'warpcore-recent-projects';
const MAX_RECENT_PROJECTS = 10;

export interface RecentProject {
  name: string;
  path: string;
  lastOpened: number;
}

export function getRecentProjects(): RecentProject[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as RecentProject[];
  } catch {
    return [];
  }
}

export function addRecentProject(name: string, path: string): void {
  const projects = getRecentProjects();
  
  // Remove existing entry for this path if it exists
  const filtered = projects.filter(p => p.path !== path);
  
  // Add new entry at the beginning
  const updated: RecentProject[] = [
    { name, path, lastOpened: Date.now() },
    ...filtered,
  ].slice(0, MAX_RECENT_PROJECTS);
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function removeRecentProject(path: string): void {
  const projects = getRecentProjects();
  const filtered = projects.filter(p => p.path !== path);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export function clearRecentProjects(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function extractProjectName(yamlContent: string): string {
  // Simple extraction of project name from YAML content
  const match = yamlContent.match(/project:\s*\n\s*name:\s*['"]?([^'"\n]+)['"]?/);
  if (match) {
    return match[1].trim();
  }
  return 'Untitled Project';
}
