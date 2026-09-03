import { Info, RefreshCw } from 'lucide-react';
import { useAppPaths } from '../../utils/useAppPaths';
import { FRONTEND_LOADED_AT, formatAgo } from '../../utils/host';
import { EmptyNote, MetricRow, SectionHeader, SubHeader } from './primitives';

export default function AboutSection() {
  const { paths, error, loading, reload } = useAppPaths();

  return (
    <div>
      <SectionHeader
        icon={Info}
        title="About"
        description="What is running. The app never calls a warpcore on your PATH; it bundles the CLI it was built against as a sidecar."
        scope={null}
      />
      {error && <EmptyNote>{error}</EmptyNote>}
      {!paths && !error && <EmptyNote>Starting the bundled CLI to ask its version…</EmptyNote>}
      {paths && (
        <>
          <MetricRow label="Visual Builder" value={paths.app_version} />
          <MetricRow
            label="Build"
            hint={paths.debug ? 'Development build (tauri dev). Release builds show no dev badge.' : 'Release build'}
            value={<span className="font-mono">{paths.git_sha}{paths.git_dirty ? '*' : ''} · {paths.debug ? 'debug' : 'release'}</span>}
          />
          <MetricRow
            label="Host compiled"
            hint="The Rust window and its commands. Only changes when src-tauri is rebuilt."
            value={paths.build_time ? `${new Date(paths.build_time * 1000).toLocaleString()} (${formatAgo(paths.build_time)})` : '-'}
          />
          <MetricRow
            label="Frontend loaded"
            hint={paths.debug ? 'UI code; in dev it hot-reloads without a host recompile.' : 'UI code, bundled with the host.'}
            value={`${new Date(FRONTEND_LOADED_AT * 1000).toLocaleString()} (${formatAgo(FRONTEND_LOADED_AT)})`}
          />
          <MetricRow label="Platform" value={paths.platform} />

          <SubHeader
            title="CLI"
            hint={
              <button onClick={reload} className="inline-flex items-center gap-1 hover:text-gray-800">
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Check again
              </button>
            }
          />
          <MetricRow
            label="Status"
            value={
              paths.cli_version
                ? <span className="text-emerald-600">● runs</span>
                : <span className="text-red-600">● not available</span>
            }
            hint={paths.cli_error ? <span className="font-mono text-red-600">{paths.cli_error}</span> : undefined}
          />
          {paths.cli_version && <MetricRow label="Version" value={<span className="font-mono">{paths.cli_version}</span>} />}
          <MetricRow
            label="Sidecar built"
            hint="A separate binary, launched per command. Rebuild with python packaging/build.py --sidecar after CLI changes."
            value={paths.sidecar_modified ? `${new Date(paths.sidecar_modified * 1000).toLocaleString()} (${formatAgo(paths.sidecar_modified)})` : '-'}
          />
          <MetricRow
            label="Binary"
            hint={<span className="font-mono">{paths.sidecar_path}</span>}
            value={paths.sidecar_bundled ? 'bundled sidecar' : <span className="text-amber-600">from PATH</span>}
          />
          {!paths.sidecar_bundled && (
            <p className="text-xs text-amber-700 mt-2">
              No bundled sidecar was found next to the app, so whatever <code className="font-mono">warpcore</code> is on your PATH is being used.
              That is normal for <code className="font-mono">tauri dev</code>; build one with <code className="font-mono">python packaging/build.py --sidecar</code>.
            </p>
          )}

          <SubHeader title="Files" />
          <MetricRow label="Home" hint={<span className="font-mono">{paths.home_warpcore}</span>} value="" />
          {paths.project_warpcore && (
            <MetricRow label="This project" hint={<span className="font-mono">{paths.project_warpcore}</span>} value="" />
          )}
        </>
      )}
    </div>
  );
}
