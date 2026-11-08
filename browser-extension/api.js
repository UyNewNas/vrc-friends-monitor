import { cleanName, isUserId, readIdentity } from './core.js';

export class ApiError extends Error {
  constructor(kind, status = 0, retryAfterMs = 0) {
    super(kind);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const delay = Number(value) * 1000;
    return Number.isSafeInteger(Math.ceil(delay)) ? Math.ceil(delay) : 0;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// The caller supplies the website-session transport. Never fall back to a
// worker-origin fetch: it can be denied even while the website is logged in.
export function createApi({ requestImpl: request, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof request !== 'function') throw new TypeError('A website request transport is required.');

  return {
    async currentUser(signal) {
      const payload = await request('auth/user', signal);
      if (Array.isArray(payload?.requiresTwoFactorAuth) && payload.requiresTwoFactorAuth.length) throw new ApiError('http', 401);
      try { return readIdentity(payload); } catch { throw new ApiError('format'); }
    },
    async friends(signal) {
      const result = new Map();
      for (const offline of [false, true]) {
        let previousPage = null;
        for (let page = 0; page < 200; page++) {
          if (signal?.aborted) throw new ApiError('cancelled');
          const body = await request(`auth/user/friends?offline=${offline}&n=100&offset=${page * 100}`, signal);
          if (!Array.isArray(body) || body.length > 100 || body.some(f => !f || !isUserId(f.id))) throw new ApiError('format');
          const fingerprint = body.map(f => f.id).sort().join('|');
          if (body.length && fingerprint === previousPage) throw new ApiError('pagination');
          previousPage = fingerprint;
          for (const friend of body) result.set(friend.id, { id: friend.id, name: cleanName(friend.displayName, friend.id) });
          if (body.length < 100) break;
          if (page === 199) throw new ApiError('pagination');
          await wait(300);
        }
      }
      return [...result.values()];
    },
  };
}
