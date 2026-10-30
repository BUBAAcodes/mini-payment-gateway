import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

// Better Auth's own endpoints (/api/auth/*). The login form uses Server Actions instead, but
// Better Auth's client and session refreshes go through here.
export const { GET, POST } = toNextJsHandler(auth);
