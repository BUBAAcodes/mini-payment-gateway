import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * "Next page" by cursor: the API's starting_after is the last ID on this page. There's no
 * "previous" cursor, so the way back is the first page (or the browser's back button).
 */
export function Pager({
  path,
  params,
  hasMore,
  lastId,
}: {
  path: string;
  /** The current filters, kept on both links. */
  params: Record<string, string | undefined>;
  hasMore: boolean;
  lastId: string | undefined;
}) {
  const onFirstPage = !params.starting_after;
  if (onFirstPage && !hasMore) return null;

  const href = (startingAfter?: string) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries({ ...params, starting_after: startingAfter })) {
      if (value) query.set(name, value);
    }
    const qs = query.toString();
    return qs ? `${path}?${qs}` : path;
  };

  return (
    <nav aria-label="Pages" className="mt-6 flex gap-3">
      {!onFirstPage && (
        <Button asChild variant="outline" size="sm">
          <Link href={href()}>First page</Link>
        </Button>
      )}
      {hasMore && lastId && (
        <Button asChild variant="outline" size="sm">
          <Link href={href(lastId)}>Next page</Link>
        </Button>
      )}
    </nav>
  );
}
