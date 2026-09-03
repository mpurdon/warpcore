// The build stamp of a dev build, wherever it is shown. Release builds
// render nothing.

import { AppPaths, buildLabel } from '../utils/host';

export default function DevBuildBadge({ paths, dark = false }: { paths: AppPaths | null; dark?: boolean }) {
  if (!paths?.debug) return null;
  const title = `Development build, commit ${paths.git_sha}${paths.git_dirty ? ' (uncommitted changes)' : ''}. A release build has no badge.`;
  return (
    <span
      className={dark
        ? 'text-[10px] font-mono uppercase tracking-wide text-purple-200 bg-purple-900/70 border border-purple-700 rounded px-1.5 py-0.5'
        : 'text-[10px] font-mono text-purple-700 bg-purple-100 border border-purple-200 rounded px-1'}
      title={title}
    >
      {buildLabel(paths)}
    </span>
  );
}
