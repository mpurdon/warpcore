// The Raw level of Overview → Evidence → Raw: the exact text the abstraction
// above it becomes. Collapsed by default so it is available without being
// presented; the simplified view must never be a dead end.

import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';

export default function ExpertView({
  title,
  text,
  language,
  defaultOpen = false,
}: {
  title: string;
  text: string;
  language?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be unavailable in the webview; nothing to do.
    }
  };

  return (
    <div className="border-t border-gray-100">
      <div className="flex items-center justify-between px-4 py-2">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-800">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
          {language && <span className="font-normal normal-case tracking-normal text-gray-400">· {language}</span>}
        </button>
        {open && (
          <button onClick={copy} className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Copy">
            {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
          </button>
        )}
      </div>
      {open && (
        <pre className="mx-4 mb-3 text-[11px] font-mono leading-snug p-3 bg-gray-900 text-gray-100 rounded max-h-72 overflow-auto whitespace-pre">
          {text}
        </pre>
      )}
    </div>
  );
}
