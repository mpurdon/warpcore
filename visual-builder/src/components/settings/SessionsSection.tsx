import { Bug } from 'lucide-react';
import FileBrowserSection from './FileBrowserSection';
import { SectionHeader } from './primitives';

export default function SessionsSection() {
  return (
    <div>
      <SectionHeader
        icon={Bug}
        title="Dev sessions"
        description="Session manifests captured when developer mode is on: the command, its traced AWS API calls and timings. Inspect one with `warpcore debug session <id>`. Safe to delete at any time."
      />
      <FileBrowserSection subdir="dev" noun="session manifests" tailLines={400} />
    </div>
  );
}
