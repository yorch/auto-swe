import type { Role } from '@auto-swe/shared';

/** The signed-in viewer every shot is taken as: an active platform admin. */
export const VIEWER = {
  email: 'ada@example.com',
  id: 'user-0001',
  isActive: true,
  name: 'Ada Lovelace',
  role: 'ADMIN' satisfies Role,
} as const;

/** `GET /api/v1/auth/me`, as the server-side role gate reads it. */
export const SERVER_SESSION_USER = {
  email: VIEWER.email,
  id: VIEWER.id,
  isActive: VIEWER.isActive,
  role: VIEWER.role,
};

/** better-auth's `GET /api/auth/get-session`, as `authStore.checkAuth` reads it. */
export const BETTER_AUTH_SESSION = {
  session: { expiresAt: '2026-10-24T09:00:00.000Z', id: 'session-0001' },
  user: {
    email: VIEWER.email,
    id: VIEWER.id,
    isActive: VIEWER.isActive,
    name: VIEWER.name,
    role: VIEWER.role,
    slackId: null,
  },
};

/** The bearer the session-token bridge mints; also set as the `accessToken` cookie. */
export const ACCESS_TOKEN = 'visual-test-token';
