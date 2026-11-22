import { createHash, createPublicKey, verify } from 'node:crypto';

export const AUDIENCE = 'https://chuck-inbox.vercel.app/api/video-inbox';
export const ISSUER = 'https://token.actions.githubusercontent.com';
export const REPOSITORY = 'mezentsevaleksey-dotcom/chuck-inbox';
export const SENDER = 'Chuck Inbox <onboarding@resend.dev>';
export const SOURCE = '[Chuck Inbox] ';
export const RESULT = '[Chuck Inbox Analysis] v2 ';
export const TEST = '[Chuck Inbox Test] ';
export const RECIPIENT_ALIAS = 'inbox@chuck.invalid';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class BridgeError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const requireValue = (ok, code = 'invalid_request', status = 400) => {
  if (!ok) throw new BridgeError(code, status);
};

export function verifyToken(token, keys, now = Date.now() / 1000) {
  try {
    requireValue(typeof token === 'string' && token.length < 16000);
    const parts = token.split('.');
    requireValue(parts.length === 3 && parts.every(x => /^[A-Za-z0-9_-]+$/.test(x)));
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    requireValue(header.alg === 'RS256' && !header.crit && typeof header.kid === 'string');
    const jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    requireValue(jwk);
    requireValue(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')),
      createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url')));
    requireValue(claims.iss === ISSUER && claims.aud === AUDIENCE);
    requireValue(['iat', 'nbf', 'exp'].every(k => Number.isFinite(claims[k])));
    requireValue(claims.exp > now && claims.nbf <= now + 30 && claims.iat <= now + 30 &&
      now - claims.iat < 600 && claims.exp - claims.iat <= 600);
    requireValue(claims.repository === REPOSITORY && claims.repository_id === '1374085463' &&
      claims.repository_owner_id === '330305019' && claims.repository_visibility === 'public');
    requireValue(claims.ref === 'refs/heads/main' && claims.ref_type === 'branch' &&
      claims.sub === `repo:${REPOSITORY}:ref:refs/heads/main` &&
      claims.workflow_ref === `${REPOSITORY}/.github/workflows/video-analysis.yml@refs/heads/main` &&
      ['schedule', 'workflow_dispatch'].includes(claims.event_name));
    requireValue(claims.runner_environment === 'github-hosted' && /^\d+$/.test(claims.run_id) &&
      /^[0-9a-f]{40}$/.test(claims.sha) && claims.workflow_sha === claims.sha);
    return claims;
  } catch { throw new BridgeError('unauthorized', 401); }
}

let keyCache;
export async function authorize(token, fetcher = fetch) {
  requireValue(typeof token === 'string' && token.length > 10 && token.length < 16000, 'unauthorized', 401);
  if (!keyCache || keyCache.expires < Date.now()) {
    const response = await fetcher(ISSUER + '/.well-known/jwks', {
      redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    requireValue(response.ok, 'identity_provider_unavailable', 503);
    const body = await response.json();
    requireValue(Array.isArray(body.keys) && body.keys.length <= 20, 'identity_provider_unavailable', 503);
    keyCache = { keys: body.keys, expires: Date.now() + 5 * 60 * 1000 };
  }
  return verifyToken(token, keyCache.keys);
}

export function canonical(raw) {
  requireValue(typeof raw === 'string' && raw.length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(raw));
  let u;
  try { u = new URL(raw); } catch { throw new BridgeError('invalid_source'); }
  requireValue(u.protocol === 'https:' && !u.username && !u.password && !u.port, 'invalid_source');
  const h = u.hostname.toLowerCase();
  let id;
  if (h === 'youtu.be') id = u.pathname.slice(1).replace(/\/$/, '');
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(h)) {
    if (u.pathname === '/watch' && u.searchParams.getAll('v').length === 1) id = u.searchParams.get('v');
    else id = u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return 'https://www.youtube.com/watch?v=' + id;
  if (['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(h)) {
    const code = u.pathname.match(/^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,30})\/?$/)?.[1];
    if (code) return 'https://www.instagram.com/p/' + code + '/';
  }
  throw new BridgeError('invalid_source');
}

export function sourceCaption(email, recipient) {
  requireValue(email.from === SENDER && Array.isArray(email.to) && email.to.length === 1 &&
    email.to[0].toLowerCase() === recipient.toLowerCase() && email.subject?.startsWith(SOURCE), 'source_not_owned', 403);
  const text = email.text || '';
  requireValue(text.startsWith('Chuck Inbox - context package item\n') && text.includes('\nText/caption:\n'), 'invalid_source');
  return text.split('\nText/caption:\n')[1].split('\nFile:')[0];
}

function containsSource(caption, url) {
  return (caption.match(/(?:https:\/\/|www\.)[^\s<>"\u201c\u201d]+/gi) || []).some(raw => {
    try { return canonical((raw.startsWith('www.') ? 'https://' : '') + raw.replace(/[.,;:!?\)\]\}\u00bb]+$/, '')) === url; }
    catch { return false; }
  });
}

export function createBridge({ key, recipient, fetcher = fetch, pause = wait, now = () => new Date() }) {
  let lastRequest = 0;
  const owns = e => e.from === SENDER && Array.isArray(e.to) && e.to.length === 1 &&
    String(e.to[0]).toLowerCase() === recipient.toLowerCase();
  async function resend(path, body, idem) {
    requireValue(key && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(recipient), 'email_not_configured', 503);
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(Math.max(0, 650 - (Date.now() - lastRequest)));
      lastRequest = Date.now();
      let response;
      try {
        response = await fetcher('https://api.resend.com' + path, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
            ...(idem ? { 'Idempotency-Key': idem } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
      } catch { throw new BridgeError('resend_unavailable', 503); }
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await pause(1000 * 2 ** attempt); continue;
      }
      requireValue(response.status !== 403, 'resend_read_access_required', 403);
      requireValue(response.ok, 'resend_request_failed', 502);
      const text = await response.text();
      requireValue(text.length <= 5 * 1024 * 1024, 'resend_response_too_large', 502);
      try { return JSON.parse(text); } catch { throw new BridgeError('invalid_resend_response', 502); }
    }
  }
  async function page(after) {
    requireValue(after == null || UUID.test(after));
    const data = await resend('/emails?limit=100' + (after ? '&after=' + after : ''));
    requireValue(Array.isArray(data.data), 'invalid_resend_response', 502);
    return data;
  }
  async function dailyRows() {
    const start = new Date(now()); start.setUTCHours(0, 0, 0, 0);
    let rows = [], cursor;
    for (let i = 0; i < 50; i++) {
      const data = await page(cursor);
      requireValue(data.data.every(e => Number.isFinite(Date.parse(e.created_at))), 'invalid_resend_response', 502);
      rows.push(...data.data.filter(e => Date.parse(e.created_at) >= start));
      if (!data.has_more || data.data.some(e => Date.parse(e.created_at) < start)) return rows;
      requireValue(data.data.length && data.data.at(-1).id !== cursor, 'incomplete_email_history', 502);
      cursor = data.data.at(-1).id;
    }
    throw new BridgeError('incomplete_email_history', 502);
  }
  async function capacity() {
    const rows = await dailyRows();
    requireValue(rows.length < 90 && rows.filter(e => owns(e) &&
      (e.subject?.startsWith(RESULT) || e.subject?.startsWith(TEST))).length < 10, 'daily_limit', 429);
  }
  async function read(id) {
    requireValue(UUID.test(id));
    return resend('/emails/' + id);
  }
  return async function operation(input, claims) {
    requireValue(input && typeof input === 'object' && !Array.isArray(input));
    switch (input.action) {
      case 'check': {
        await page(); return { ok: true, read_access: true, recipient_configured: true };
      }
      case 'list': {
        const data = await page(input.after);
        return { has_more: Boolean(data.has_more), data: data.data.map(e => {
          const ours = owns(e) && (e.subject?.startsWith(SOURCE) || e.subject?.startsWith(RESULT));
          return { id: e.id, created_at: e.created_at, from: ours ? SENDER : '',
            to: ours ? [RECIPIENT_ALIAS] : [], subject: ours ? e.subject : '', last_event: ours ? e.last_event : '' };
        }) };
      }
      case 'read': {
        const email = await read(input.id);
        const caption = sourceCaption(email, recipient);
        return { text: 'Chuck Inbox - context package item\n\nText/caption:\n' + caption };
      }
      case 'deliver': {
        requireValue(input.job && typeof input.report === 'string' && input.report.length <= 100000);
        const url = canonical(input.job.url);
        requireValue(url === input.job.url, 'invalid_source');
        const original = await read(input.job.source_id);
        requireValue(containsSource(sourceCaption(original, recipient), url), 'source_mismatch', 403);
        const age = now().getTime() - Date.parse(original.created_at);
        requireValue(Number.isFinite(age) && age >= -60000 && age < 20 * 3600000, 'source_expired', 403);
        await capacity();
        const digest = createHash('sha256').update(url).digest('hex');
        const body = { from: SENDER, to: [recipient], subject: RESULT + digest,
          text: `Chuck Inbox — автоматический разбор\nИсходная ссылка: ${url}\nИсходное письмо: ${original.id}\n\n${input.report}` };
        if (input.frames) {
          requireValue(typeof input.frames === 'string' && input.frames.length < 2800000 &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(input.frames), 'invalid_attachment');
          const bytes = Buffer.from(input.frames, 'base64');
          requireValue(bytes.length <= 2 * 1024 * 1024 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255, 'invalid_attachment');
          body.attachments = [{ filename: 'sampled-frames.jpg', content: input.frames }];
        }
        const result = await resend('/emails', body, 'chuck-video-v2-' + digest);
        requireValue(UUID.test(result.id), 'email_not_accepted', 502);
        return { id: result.id };
      }
      case 'delivery-test': {
        requireValue(claims.event_name === 'workflow_dispatch', 'manual_test_only', 403);
        await capacity();
        const result = await resend('/emails', { from: SENDER, to: [recipient], subject: TEST + claims.run_id,
          text: 'Техническая проверка Chuck Inbox: GitHub Actions подключён к существующей почтовой функции Vercel. Это тест доставки, не разбор видео. Обычная пересылка Telegram → Gmail не изменена.' },
        'chuck-video-test-' + claims.run_id);
        requireValue(UUID.test(result.id), 'email_not_accepted', 502);
        return { id: result.id };
      }
      case 'delivery-status': {
        const email = await read(input.id);
        requireValue(owns(email) && (email.subject?.startsWith(RESULT) || email.subject === TEST + claims.run_id), 'source_not_owned', 403);
        return { status: email.last_event || 'unknown' };
      }
      default: throw new BridgeError('unknown_operation');
    }
  };
}
