// Taking over a discovered resource: the CLI rewrites the deployment state
// (discovery/takeover.py) and says what the previous manager must be told.

import { invoke } from '@tauri-apps/api/core';

export interface TakeoverItem {
  resource_id: string;
  resource_type: string;
  physical_id: string | null;
  action: 'taken' | 'already' | 'unsupported' | 'not-found' | 'not-adopted';
  detail: string;
  provenance: Record<string, unknown>;
}

export interface TakeoverResult {
  items: TakeoverItem[];
  /** What to tell Terraform, SST or CloudFormation so they stop managing the resource. */
  release: string[];
  taken: number;
}

export async function takeOver(configPath: string, environment: string, resources: string[], dryRun = false): Promise<TakeoverResult> {
  const raw = await invoke<string>('takeover_resources', { configPath, environment, resources, dryRun });
  return JSON.parse(raw) as TakeoverResult;
}

/** Who deployed a resource, as the import recorded it on the node. */
export interface Provenance {
  manager: string;
  /** CloudFormation stack, Terraform module path, SST app: whatever names the owner. */
  stack?: string;
  address?: string;
  app?: string;
  stage?: string;
  logical_id?: string;
  urn?: string;
  /** How the manager was recognised: a tag, a stack, a state file. */
  evidence?: string;
}

export const MANAGER_LABEL: Record<string, string> = {
  terraform: 'Terraform', opentofu: 'OpenTofu', 'sst-v3': 'SST', 'sst-v2': 'SST v2', cdk: 'AWS CDK', sam: 'AWS SAM',
  serverless: 'Serverless Framework', cloudformation: 'CloudFormation', pulumi: 'Pulumi', amplify: 'Amplify',
  copilot: 'AWS Copilot', warpcore: 'warpcore', console: 'the console or an unknown tool',
};
