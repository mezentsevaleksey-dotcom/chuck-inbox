import { authorize, BridgeError, createBridge } from '../lib/videoBridge.mjs';

// This separate endpoint never returns the existing Vercel email credentials.
// Only this repository's main-branch analysis workflow can call it with OIDC.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'post_required' });
  try {
    const auth = req.headers?.authorization || '';
    if (!auth.startsWith('Bearer ')) throw new BridgeError('unauthorized', 401);
    const claims = await authorize(auth.slice(7));
    let input = req.body;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > 3100000) throw new BridgeError('request_too_large', 413);
      input = JSON.parse(input);
    }
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > 3100000) throw new BridgeError('request_too_large', 413);
    const operation = createBridge({ key: process.env.RESEND_API_KEY, recipient: process.env.CHUCK_INBOX_EMAIL || '' });
    return res.status(200).json(await operation(input, claims));
  } catch (error) {
    // Never log request bodies, bearer tokens, email content or provider errors.
    return res.status(error instanceof BridgeError ? error.status : 500)
      .json({ error: error instanceof BridgeError ? error.code : 'bridge_internal_error' });
  }
}
