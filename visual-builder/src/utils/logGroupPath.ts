import { Node } from 'reactflow';

// Map resource types to their log group path segment (plural form)
const resourceTypeToPathSegment: Record<string, string> = {
  'agent': 'agents',
  'lambda': 'lambdas',
  'api-gateway': 'api-gateways',
  'step-functions': 'step-functions',
  'eventbridge-rule': 'eventbridge-rules',
};

/**
 * Generate a log group path based on the connected resource
 * Format: /{project-name}/{resource-type}/{resource-name}
 */
export function generateLogGroupPath(
  sourceNode: Node | undefined,
  projectName: string | null
): string {
  if (!sourceNode) return '';

  const sourceType = sourceNode.type || '';
  const pathSegment = resourceTypeToPathSegment[sourceType];

  if (!pathSegment) return '';

  // Get resource name from config or label
  const resourceName = sourceNode.data?.config?.name ||
                       sourceNode.data?.config?.functionName ||
                       sourceNode.data?.config?.apiName ||
                       sourceNode.data?.config?.ruleName ||
                       sourceNode.data?.label ||
                       '';

  if (!resourceName) return '';

  // Format the resource name (lowercase, hyphens)
  const formattedName = resourceName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  // Use project name or default
  const project = projectName || 'my-project';
  const formattedProject = project
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  return `/${formattedProject}/${pathSegment}/${formattedName}`;
}

/**
 * Check if a log group should auto-populate its path from a connected source
 */
export function shouldAutoPopulateLogGroupPath(
  sourceType: string,
  targetType: string
): boolean {
  return targetType === 'log-group' &&
         Object.keys(resourceTypeToPathSegment).includes(sourceType);
}
