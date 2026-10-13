// The registry and what is derived from it: the list, the tool schemas a
// model is handed, the palette rows, the shortcut table. Commands register
// at import time from the group modules; `all()` is the single source.

import type { StoreState } from '../store/useStore';
import { selectReadOnly } from '../store/useStore';
import { GROUPS, type Args, type CommandSpec, type Instance, type Param } from './types';

const registry = new Map<string, CommandSpec>();
// Derived tables, built once the registry is complete; a define() resets them.
let toolCache: ToolSpec[] | null = null;
let shortcutCache: ShortcutRow[] | null = null;

export function define(spec: CommandSpec): CommandSpec {
  // A dev build re-runs a group module when it is edited, so a redefinition
  // there is the new version of the command, not a mistake.
  if (registry.has(spec.id) && !import.meta.env.DEV) throw new Error(`command ${spec.id} is defined twice`);
  if (!/^[a-z]+\.[a-zA-Z]+$/.test(spec.id)) throw new Error(`command id ${spec.id} is not group.name`);
  registry.set(spec.id, spec);
  toolCache = null;
  shortcutCache = null;
  return spec;
}

export function get(id: string): CommandSpec | undefined {
  return registry.get(id);
}

export function all(): CommandSpec[] {
  return [...registry.values()];
}

export function titleOf(spec: CommandSpec, state: StoreState): string {
  return typeof spec.title === 'function' ? spec.title(state) : spec.title;
}

/** The one line for a run of the command with these args: the receipt, the card, the transcript. */
export function summaryOf(spec: CommandSpec, args: Args, state: StoreState): string {
  return spec.describe ? spec.describe(args, state) : titleOf(spec, state);
}

/**
 * What to ask before running, or null. A command's own question wins; an
 * aws-change command without one is asked about anyway, whoever calls.
 */
export function confirmQuestion(spec: CommandSpec, args: Args, state: StoreState): string | null {
  return spec.confirm?.(args, state) ?? (spec.kind === 'aws-change' ? `${summaryOf(spec, args, state)}?` : null);
}

/**
 * Why a command cannot run now, or null. The lock and the Holodeck preview
 * block every project command in one place, so no command can forget.
 */
export function blocked(spec: CommandSpec, state: StoreState): string | null {
  if (spec.kind === 'project' && selectReadOnly(state)) {
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
  /** The command id the tool stands for, so no caller has to map names back. */
  command: string;
  description: string;
  kind: CommandSpec['kind'];
  /** Whether a model is offered it; the bridge and the assistant filter on this. */
  forModel: boolean;
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

const KIND_NOTE: Record<CommandSpec['kind'], string> = {
  view: 'Changes only the operator\'s view; applies immediately.',
  project: 'Edits the project; applies immediately, can be undone, and is refused while the project is locked.',
  file: 'Writes the project\'s own files beside it; applies immediately.',
  'aws-read': 'Reads the AWS account; slow, changes nothing.',
  'aws-change': 'Changes the AWS account or deployment state; pauses for the operator\'s confirmation.',
  query: 'Answers from what the app holds; exact, immediate.',
};

/** Every command as a tool. The kind is in the description so a model knows what asks first. Built once. */
export function toolSpecs(opts: { forModel?: boolean } = {}): ToolSpec[] {
  toolCache ??= all().map((spec) => ({
    name: spec.id.replace('.', '_'),
    command: spec.id,
    description: `${spec.description} ${KIND_NOTE[spec.kind]}`,
    kind: spec.kind,
    forModel: !spec.notForModel,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(spec.params ?? {}).map(([k, p]) => [k, jsonSchema(p)])),
      required: Object.entries(spec.params ?? {}).filter(([, p]) => p.required).map(([k]) => k),
    },
  }));
  return opts.forModel ? toolCache.filter((t) => t.forModel) : toolCache;
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
          shortcut: shortcutLabel(spec), tone: inst.tone, blockedReason: reason,
        });
      }
      continue;
    }
    rows.push({
      id: spec.id, command: spec.id, args: {}, group: spec.group, title: titleOf(spec, state),
      subtitle: reason ?? spec.description, keywords: spec.keywords, shortcut: shortcutLabel(spec), blockedReason: reason,
    });
  }
  return rows.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}

export interface ShortcutRow {
  command: string;
  keys: string[];
  mod: boolean;
  shift: boolean;
  label: string;
  inEditable: boolean;
  overDialogs: boolean;
  args: Args;
  /** The command's description, for the help sheet. */
  what: string;
  group: CommandSpec['group'];
}

/** The binding a command shows: the first of its shortcuts. */
export function shortcutLabel(spec: CommandSpec): string | undefined {
  const first = Array.isArray(spec.shortcut) ? spec.shortcut[0] : spec.shortcut;
  return first?.label;
}

/** Every key binding, for the key handler and the help sheet. Built once. */
export function shortcuts(): ShortcutRow[] {
  shortcutCache ??= all().flatMap((s) => {
    const list = Array.isArray(s.shortcut) ? s.shortcut : s.shortcut ? [s.shortcut] : [];
    return list.map((sc) => ({
      command: s.id, keys: sc.keys, mod: Boolean(sc.mod), shift: Boolean(sc.shift), label: sc.label,
      inEditable: sc.inEditable ?? Boolean(sc.mod), overDialogs: Boolean(sc.overDialogs), args: sc.args ?? {},
      what: s.description, group: s.group,
    }));
  });
  return shortcutCache;
}
