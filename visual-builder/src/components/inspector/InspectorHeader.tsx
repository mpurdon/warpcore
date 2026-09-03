// Resource identity: kind + name + scope + state, at the top of every
// inspector subject. Status is a restrained semantic dot, not a banner.

import { ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, LucideIcon } from 'lucide-react';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

const DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  info: 'bg-blue-500',
  muted: 'bg-gray-300',
};

export function StatusDot({ tone, label, pulse = false }: { tone: Tone; label: string; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <span className={`inline-block h-2 w-2 rounded-full ${DOT[tone]} ${pulse ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
}

export default function InspectorHeader({
  icon: Icon,
  kind,
  name,
  subtitle,
  status,
  actions,
  onBack,
}: {
  icon: LucideIcon;
  kind: string;
  name: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <div className="px-4 py-3 border-b border-gray-200 flex-shrink-0">
      <div className="flex items-start gap-3">
        {onBack ? (
          <button onClick={onBack} className="mt-0.5 p-1 -ml-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Back">
            <ArrowLeft size={16} />
          </button>
        ) : (
          <Icon size={18} className="mt-0.5 text-gray-400 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-gray-400">{kind}</div>
          <div className="text-base font-semibold text-gray-900 truncate" title={name}>{name}</div>
          {subtitle && <div className="text-xs text-gray-500 truncate">{subtitle}</div>}
          {status && <div className="mt-1.5">{status}</div>}
        </div>
        {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

export function InspectorTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex border-b border-gray-200 flex-shrink-0 px-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
            active === t.id
              ? 'text-blue-700 border-blue-600'
              : 'text-gray-500 border-transparent hover:text-gray-800'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="px-4 py-3 border-b border-gray-100">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
        {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * One fact. When it leads somewhere it reads as a link: blue, underlined on
 * hover, with an arrow, so a related resource is obviously one click away.
 */
export function Fact({ label, value, onClick, mono = false }: { label: string; value: ReactNode; onClick?: () => void; mono?: boolean }) {
  if (onClick) {
    return (
      <button onClick={onClick} className="group w-full flex items-center justify-between gap-3 py-1 -mx-1 px-1 rounded hover:bg-blue-50 text-left" title="Open in the inspector">
        <span className="text-xs text-gray-500 shrink-0">{label}</span>
        <span className={`text-xs text-blue-700 group-hover:underline text-right truncate inline-flex items-center gap-1 min-w-0 ${mono ? 'font-mono' : ''}`}>
          <span className="truncate">{value}</span>
          <ArrowUpRight size={11} className="shrink-0 text-blue-400" />
        </span>
      </button>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className={`text-xs text-gray-900 text-right truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
