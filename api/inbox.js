import { get, list } from '@vercel/blob';
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

function requestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
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

  const date = String(req.query?.date || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'Invalid date. Use YYYY-MM-DD.' });
  }

  const prefix = `inbox/${date}/`;
  const items = [];
  let cursor;

  do {
    const result = await list({ prefix, cursor, limit: 250 });
    const metadataBlobs = result.blobs.filter((blob) => blob.pathname.endsWith('/metadata.json'));

    for (const blob of metadataBlobs) {
      try {
        const metadata = await readJson(blob.pathname);
        if (!metadata) continue;

        const basePath = blob.pathname.replace(/\/metadata\.json$/, '');
        const filePathname = metadata.file?.pathname || null;
        const fileUrl = filePathname
          ? `${requestOrigin(req)}/api/file?token=${encodeURIComponent(token)}&pathname=${encodeURIComponent(filePathname)}`
          : null;

        items.push({
          id: basePath.split('/').pop(),
          savedAt: metadata.savedAt,
          type: metadata.type,
          text: metadata.text,
          caption: metadata.caption,
          forwarded: metadata.forwarded,
          forwardOrigin: metadata.forwardOrigin,
          from: metadata.from,
          file: metadata.file ? {
            pathname: filePathname,
            contentType: metadata.file.contentType,
            size: metadata.file.size,
            previewUrl: fileUrl
          } : null
        });
      } catch (error) {
        console.error('Failed to read inbox metadata:', blob.pathname, error);
      }
    }

    cursor = result.cursor;
  } while (cursor);

  items.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    date,
    expiresAt: share.expiresAt,
    count: items.length,
    items
  });
}
