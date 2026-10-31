'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/** A small icon button that copies `value`, e.g. an ID to paste into a support ticket or curl. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** An ID in monospace with a copy button next to it. */
export function CopyableId({ id, label = 'ID' }: { id: string; label?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 truncate font-mono text-xs">{id}</code>
      <CopyButton value={id} label={label} />
    </span>
  );
}
