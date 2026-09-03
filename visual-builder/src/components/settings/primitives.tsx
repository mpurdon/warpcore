// Building blocks for the settings sections: a header, a labelled field, a
// metric row that doubles as navigation, and a path row with a reveal
// button. Kept deliberately plain - thin separators, no cards.

import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ExternalLink, LucideIcon, RefreshCw } from 'lucide-react';
import { DirUsage, describeUsage, dirUsage, openPath } from '../../utils/host';

export function SectionHeader({
  icon: Icon,
  title,
  description,
  scope = 'This machine only',
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  scope?: string | null;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <Icon size={18} className="text-gray-500" />
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {scope && (
          <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
            {scope}
          </span>
        )}
      </div>
      {description && <p className="text-sm text-gray-500 mt-1 max-w-2xl">{description}</p>}
    </div>
  );
}

export function SubHeader({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mt-8 mb-2">
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </div>
  );
}

/** Label and description on the left, control on the right. */
export function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-gray-100 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-700">{label}</div>
        {description && <div className="text-xs text-gray-500 mt-0.5 max-w-md">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * A fact that is also a place to go. "Audit trail · 142 entries · 3.1 MB"
 * should be clickable, per the guidance: information as navigation.
 */
export function MetricRow({
  label,
  value,
  hint,
  onClick,
  actions,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  onClick?: () => void;
  actions?: ReactNode;
}) {
  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-800">{label}</div>
        {hint && <div className="text-xs text-gray-500 truncate">{hint}</div>}
      </div>
      <div className="text-sm text-gray-900 tabular-nums shrink-0">{value}</div>
    </>
  );
  return (
    <div className="flex items-center gap-4 py-2 border-b border-gray-100 last:border-b-0">
      {onClick ? (
        <button onClick={onClick} className="flex items-center gap-4 flex-1 min-w-0 text-left hover:bg-gray-50 -mx-2 px-2 py-0.5 rounded">
          {inner}
        </button>
      ) : (
        <div className="flex items-center gap-4 flex-1 min-w-0">{inner}</div>
      )}
      {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
    </div>
  );
}

export function SmallButton({
  onClick,
  children,
  title,
  danger = false,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? 'border-red-200 text-red-700 hover:bg-red-50'
          : 'border-gray-200 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

/** A directory's size and file count, refreshed on demand. */
export function useDirUsage(path: string | null | undefined) {
  const [usage, setUsage] = useState<DirUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    dirUsage(path)
      .then((u) => { if (!cancelled) { setUsage(u); setError(null); } })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { usage, error, reload };
}

/** Where something lives on disk, with a reveal button. */
export function PathRow({
  label,
  path,
  usage,
  onReload,
  actions,
}: {
  label: string;
  path: string;
  usage?: DirUsage | null;
  onReload?: () => void;
  actions?: ReactNode;
}) {
  const reveal = () => openPath(path).catch((e) => alert(String(e)));
  const summary = describeUsage(usage);
  return (
    <MetricRow
      label={label}
      hint={<span className="font-mono">{path}</span>}
      value={summary}
      actions={
        <>
          {actions}
          {onReload && (
            <button onClick={onReload} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Refresh">
              <RefreshCw size={13} />
            </button>
          )}
          <button
            onClick={reveal}
            disabled={usage ? !usage.exists : false}
            className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30"
            title="Reveal in file manager"
          >
            <ExternalLink size={13} />
          </button>
        </>
      }
    />
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { label: string; value: T }[];
  disabled?: boolean;
}) {
  const numeric = typeof value === 'number';
  return (
    <select
      value={String(value)}
      disabled={disabled}
      onChange={(e) => onChange((numeric ? Number(e.target.value) : e.target.value) as T)}
      className="text-sm border border-gray-300 rounded px-2 py-1.5 bg-white min-w-[160px] disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-gray-500 py-3">{children}</p>;
}
