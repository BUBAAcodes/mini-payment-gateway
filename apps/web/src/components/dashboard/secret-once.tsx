'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A secret the API returned this once (an API key or a webhook signing secret). It lives only in
 * this component's props: not in the URL, a cookie or storage, and it's gone on reload.
 */
export function SecretOnce({ label, secret }: { label: string; secret: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
  }

  return (
    <div role="status" className="space-y-3 rounded-card border border-foreground p-4">
      <p className="text-sm font-semibold">
        {label}. Copy it now: you won&apos;t be able to see it again.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-control bg-card px-3 py-2 font-mono text-sm whitespace-nowrap">
          {secret}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
