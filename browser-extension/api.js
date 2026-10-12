import { cleanName, isUserId, readIdentity } from './core.js';

export const API_BASE = 'https://vrchat.com/api/1/';
const RESPONSE_LIMIT = 4 * 1024 * 1024;

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

export function createApi({ fetchImpl = fetch, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  async function request(path, signal) {
    const timeout = AbortSignal.timeout(20_000);
    try {
      const response = await fetchImpl(API_BASE + path, {
        method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow',
        headers: { Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new ApiError('http', response.status, parseRetryAfter(response.headers.get('Retry-After'), now()));
      if (!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) throw new ApiError('format');
      const text = await response.text();
      if (text.length > RESPONSE_LIMIT) throw new ApiError('format');
      try { return JSON.parse(text); } catch { throw new ApiError('format'); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw new ApiError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
      throw new ApiError(timeout.aborted ? 'timeout' : 'network');
    }
  }

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
