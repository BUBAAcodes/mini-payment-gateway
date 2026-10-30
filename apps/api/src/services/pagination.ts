export interface Page<T> {
  data: T[];
  has_more: boolean;
}

/**
 * The `where` clause for rows after `cursor` in newest-first order (created_at desc, id desc).
 * The ID breaks ties between rows created in the same millisecond.
 */
export function olderThan(cursor: { createdAt: Date; id: string }) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/** Turns `limit + 1` fetched rows into a page: the extra row only says there is more. */
export function toPage<T>(rows: T[], limit: number): Page<T> {
  return { data: rows.slice(0, limit), has_more: rows.length > limit };
}
