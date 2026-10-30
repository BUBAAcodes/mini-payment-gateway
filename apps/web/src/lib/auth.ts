import 'server-only';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { prisma } from '@gateway/db';

// Dashboard logins (section 13). Better Auth keeps users, sessions and password hashes in the
// tables from step 5, through the one shared Prisma client. It reads BETTER_AUTH_SECRET (signs
// session cookies) and BETTER_AUTH_URL (this app's public URL) from the environment.

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    // Signing up must also create a merchant; that comes with the dashboard pages (step 20).
    disableSignUp: true,
  },
  user: {
    additionalFields: {
      // Which merchant this login sees. input: false, so no sign-up or profile update can set it.
      merchantId: { type: 'string', required: false, input: false },
    },
  },
  // Lets Server Actions set and clear the session cookie.
  plugins: [nextCookies()],
});
