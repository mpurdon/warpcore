// Reaching an instance: the CLI's connect advisor (warpcore discover
// connect), read through Tauri. Advice, then one deliberate action.

import { invoke } from '@tauri-apps/api/core';

export interface ConnectCheck {
  id: string;
  /** null: could not be determined. */
  ok: boolean | null;
  label: string;
  detail: string;
}

export interface ConnectPlan {
  arn: string;
  instance_id: string;
  name: string;
  state: string | null;
  platform: 'linux' | 'windows';
  method: 'ssm' | 'ssh' | 'ssh-jump' | 'rdp' | 'none';
  command: string | null;
  user: string | null;
  key_name: string | null;
  key_path: string | null;
  public_ip: string | null;
  private_ip: string | null;
  jump: { instance_id: string; name: string; public_ip: string; user: string; key_name: string | null; key_path: string | null } | null;
  my_ip: string | null;
  checks: ConnectCheck[];
  notes: string[];
}

export async function fetchConnectPlan(profile: string, arn: string): Promise<ConnectPlan> {
  const raw = await invoke<string>('instance_connect', { profile, arn });
  return JSON.parse(raw) as ConnectPlan;
}

/** Open the composed command in a terminal. The backend recomputes it from the ARN. */
export async function openConnectSession(profile: string, arn: string): Promise<string> {
  return invoke<string>('open_connect_session', { profile, arn });
}

export const METHOD_LABEL: Record<ConnectPlan['method'], string> = {
  ssm: 'Session Manager',
  ssh: 'SSH',
  'ssh-jump': 'SSH through the bastion',
  rdp: 'Remote Desktop',
  none: 'No way in from here',
};
