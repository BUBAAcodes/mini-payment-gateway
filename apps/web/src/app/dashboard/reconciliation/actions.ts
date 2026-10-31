'use server';

import { refresh } from 'next/cache';
import type { ActionState } from '@/lib/action-state';
import { INVALID_REQUEST, apiErrorState, isUuid } from '@/lib/dashboard-actions';
import { resolveReconciliationIssue } from '@/lib/dashboard-api';
import { requireMerchant } from '@/lib/session';

export async function resolveIssue(issueId: unknown): Promise<ActionState> {
  const { merchantId } = await requireMerchant();
  if (!isUuid(issueId)) return INVALID_REQUEST;
  const result = await resolveReconciliationIssue(merchantId, issueId);
  if (!result.ok) return apiErrorState(result);
  refresh();
  return { status: 'done', message: 'Marked resolved.' };
}
