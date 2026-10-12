// The registry and what is derived from it: the list, the tool schemas a
// model is handed, the palette rows, the shortcut table. Commands register
// at import time from the group modules; `all()` is the single source.

import type { StoreState } from '../store/useStore';
import { selectReadOnly } from '../store/useStore';
import type { Args, CommandSpec, Instance, Param } from './types';

const registry = new Map<string, CommandSpec>();

export function define(spec: CommandSpec): CommandSpec {
  if (registry.has(spec.id)) throw new Error(`command ${spec.id} is defined twice`);
  if (!/^[a-z]+\.[a-zA-Z]+$/.test(spec.id)) throw new Error(`command id ${spec.id} is not group.name`);
  registry.set(spec.id, spec);
  return spec;
}

export function get(id: string): CommandSpec | undefined {
  return registry.get(id);
}

export function all(): CommandSpec[] {
  return [...registry.values()];
}

/** For tests that build their own registry. */
export function _clear(): void {
  registry.clear();
}

export function titleOf(spec: CommandSpec, state: StoreState): string {
  return typeof spec.title === 'function' ? spec.title(state) : spec.title;
}

/**
 * Why a command cannot run now, or null. The lock and the Holodeck preview
 * block every project command in one place, so no command can forget.
 */
export function blocked(spec: CommandSpec, state: StoreState): string | null {
  if (spec.kind === 'project' && !spec.ignoresLock && selectReadOnly(state)) {
    return state.holodeckPreview ? 'The Holodeck preview is read-only' : 'The project is locked. Unlock it to edit.';
  }
  return spec.available?.(state) ?? null;
}

// ------------------------------------------------------------ validation

export class ArgError extends Error {}

function typeOk(value: unknown, type: Param['type']): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

/** The args a command accepts, checked against its params. Unknown keys are dropped, not errors. */
export function validate(spec: CommandSpec, args: Args): Args {
  const params = spec.params ?? {};
  const out: Args = {};
  for (const [name, p] of Object.entries(params)) {
    const value = args[name];
    if (value === undefined || value === null) {
      if (p.required) throw new ArgError(`${spec.id}: ${name} is required (${p.description})`);
      continue;
    }
    if (!typeOk(value, p.type)) throw new ArgError(`${spec.id}: ${name} must be a ${p.type}`);
    if (p.enum && !p.enum.includes(value as string)) throw new ArgError(`${spec.id}: ${name} must be one of ${p.enum.join(', ')}`);
    out[name] = value;
  }
  return out;
}

// ------------------------------------------------------------ tool specs

export interface ToolSpec {
  name: string;
  description: string;
  kind: CommandSpec['kind'];
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

function jsonSchema(p: Param): Record<string, unknown> {
  const base: Record<string, unknown> = { description: p.description };
  switch (p.type) {
    case 'string[]': return { ...base, type: 'array', items: { type: 'string' } };
    case 'object': return { ...base, type: 'object' };
    case 'string': return p.enum ? { ...base, type: 'string', enum: [...p.enum] } : { ...base, type: 'string' };
    default: return { ...base, type: p.type };
  }
}

/** Every command as a tool a model can call. The kind is in the description so the model knows what asks first. */
export function toolSpecs(): ToolSpec[] {
  const note: Record<CommandSpec['kind'], string> = {
    view: 'Changes only the operator\'s view; applies immediately.',
    project: 'Edits the project; applies immediately and can be undone.',
    'aws-read': 'Reads the AWS account; slow, changes nothing.',
    'aws-change': 'Changes the AWS account or deployment state; pauses for the operator\'s confirmation.',
    query: 'Answers from what the app holds; exact, immediate.',
  };
  return all().map((spec) => ({
    name: spec.id.replace('.', '_'),
    description: `${spec.description} ${note[spec.kind]}`,
    kind: spec.kind,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(spec.params ?? {}).map(([k, p]) => [k, jsonSchema(p)])),
      required: Object.entries(spec.params ?? {}).filter(([, p]) => p.required).map(([k]) => k),
    },
  }));
}

/** A tool name back to the command id. */
export function commandForTool(name: string): CommandSpec | undefined {
  const at = name.indexOf('_');
  return at < 0 ? undefined : get(`${name.slice(0, at)}.${name.slice(at + 1)}`);
}

// ------------------------------------------------------------ palette

export interface PaletteRow {
  id: string;
  command: string;
  args: Args;
  group: CommandSpec['group'];
  title: string;
  subtitle?: string;
  keywords?: string[];
  shortcut?: string;
  tone?: Instance['tone'];
  /** Why it would not run; shown, and the row runs anyway so the reason is the answer. */
  blockedReason: string | null;
}

const GROUP_ORDER: CommandSpec['group'][] = ['Actions', 'View', 'Scenarios', 'Canvas', 'Environments', 'Account', 'Settings', 'Queries'];

/** Every row the palette shows, from the registry and the state, actions first. */
export function paletteRows(state: StoreState): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const spec of all()) {
    if (spec.hidden) continue;
    const reason = blocked(spec, state);
    if (spec.instances) {
      for (const inst of spec.instances(state)) {
        rows.push({
          id: `${spec.id}:${inst.key}`, command: spec.id, args: inst.args, group: spec.group, title: inst.title,
          subtitle: reason ?? inst.subtitle, keywords: [...(spec.keywords ?? []), ...(inst.keywords ?? [])],
          shortcut: spec.shortcut?.label, tone: inst.tone, blockedReason: reason,
        });
      }
      continue;
    }
    rows.push({
      id: spec.id, command: spec.id, args: {}, group: spec.group, title: titleOf(spec, state),
      subtitle: reason ?? spec.description, keywords: spec.keywords, shortcut: spec.shortcut?.label, blockedReason: reason,
    });
  }
  return rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

/** Every shortcut, for the key handler and the help sheet. */
export function shortcuts(): { command: string; key: string; mod: boolean; shift: boolean; label: string }[] {
  return all().filter((s) => s.shortcut).map((s) => ({
    command: s.id, key: s.shortcut!.key, mod: Boolean(s.shortcut!.mod), shift: Boolean(s.shortcut!.shift), label: s.shortcut!.label,
  }));
}
