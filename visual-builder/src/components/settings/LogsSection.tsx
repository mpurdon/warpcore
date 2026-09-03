import { FileText } from 'lucide-react';
import FileBrowserSection from './FileBrowserSection';
import { SectionHeader } from './primitives';

export default function LogsSection() {
  return (
    <div>
      <SectionHeader
        icon={FileText}
        title="Application logs"
        description="One JSONL file per day, written by every CLI run at debug level whatever the console level. Runs with a project open log beside that project's warpcore.yaml; everything else logs under your home directory."
      />
      <FileBrowserSection subdir="logs" noun="log files" tailLines={300} />
    </div>
  );
}
