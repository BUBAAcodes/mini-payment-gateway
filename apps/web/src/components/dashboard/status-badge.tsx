import { Badge } from '@/components/ui/badge';
import type { Tone } from '@/lib/dashboard-format';

const VARIANTS = {
  success: 'default',
  danger: 'destructive',
  waiting: 'secondary',
  neutral: 'outline',
} as const satisfies Record<Tone, string>;

/** A status pill: black for money that arrived, red for failures, grey while waiting. */
export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <Badge variant={VARIANTS[tone]} className="font-pill capitalize">
      {children}
    </Badge>
  );
}
