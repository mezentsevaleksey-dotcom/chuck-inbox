import { get } from '@vercel/blob';
import { createHash } from 'node:crypto';

async function readJson(pathname) {
  const result = await get(pathname, { access: 'private' });
  if (!result || result.statusCode !== 200) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

async function validateShareToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = createHash('sha256').update(String(rawToken)).digest('hex');
  const record = await readJson(`shares/${tokenHash}.json`);
  if (!record?.expiresAt) return null;
  if (Date.now() > new Date(record.expiresAt).getTime()) return null;
  return record;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = req.query?.token;
  const share = await validateShareToken(token);
  if (!share) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired share token' });
  }

  const pathname = String(req.query?.pathname || '');
  if (!pathname.startsWith('inbox/')) {
    return res.status(400).json({ ok: false, error: 'Invalid pathname' });
  }

  const result = await get(pathname, { access: 'private' });
  if (!result || result.statusCode !== 200) {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', result.blob?.contentType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const reader = result.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}
