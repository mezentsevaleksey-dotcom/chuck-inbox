const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function senderName(message) {
  const origin = message.forward_origin;
  if (origin?.type === 'user' && origin.sender_user) {
    return [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(' ') || origin.sender_user.username || 'Forwarded user';
  }
  if (origin?.type === 'hidden_user') return origin.sender_user_name || 'Hidden sender';
  if (origin?.type === 'channel' && origin.chat) return origin.chat.title || origin.chat.username || 'Channel';
  if (message.forward_sender_name) return message.forward_sender_name;
  return [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || message.from?.username || 'Telegram';
}

export function makeEmailAttachment(buffer, filename, contentType) {
  if (!buffer || buffer.byteLength > MAX_EMAIL_ATTACHMENT_BYTES) return null;
  return {
    filename: filename || 'file',
    content: Buffer.from(buffer).toString('base64'),
    content_type: contentType || 'application/octet-stream'
  };
}

function buildText(message, classification, pkg, savedFile) {
  const telegramTime = message.date ? new Date(message.date * 1000).toISOString() : null;
  const text = message.text ?? message.caption ?? '';
  return [
    'Chuck Inbox - context package item',
    '',
    `Package ID: ${pkg.packageId}`,
    `Package date: ${pkg.date}`,
    `Package started: ${pkg.startedAt}`,
    `Message type: ${classification.type}`,
    `Sender/source: ${senderName(message)}`,
    `Forwarded: ${message.forward_origin || message.forward_from || message.forward_sender_name ? 'yes' : 'no'}`,
    telegramTime ? `Telegram time: ${telegramTime}` : null,
    message.reply_to_message ? `Reply to: ${message.reply_to_message.text ?? message.reply_to_message.caption ?? '[media]'}` : null,
    '',
    text ? 'Text/caption:' : null,
    text || null,
    savedFile ? '' : null,
    savedFile ? `File: ${savedFile.fileName || savedFile.pathname}` : null,
    savedFile ? `MIME: ${savedFile.contentType}` : null,
    savedFile ? `Size: ${savedFile.size} bytes` : null,
    savedFile && savedFile.size > MAX_EMAIL_ATTACHMENT_BYTES ? 'Attachment note: file is archived in private storage and was too large to attach to email.' : null
  ].filter((v) => v !== null && v !== undefined).join('\n');
}

export async function sendToGmail({ message, classification, pkg, savedFile, emailAttachment, updateId }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CHUCK_INBOX_EMAIL;
  if (!apiKey || !to) throw new Error('Email bridge is not configured');

  const body = {
    from: 'Chuck Inbox <onboarding@resend.dev>',
    to: [to],
    subject: `[Chuck Inbox] ${pkg.packageId}`,
    text: buildText(message, classification, pkg, savedFile),
    headers: {
      'X-Chuck-Package-ID': pkg.packageId,
      'X-Chuck-Telegram-Message-ID': String(message.message_id ?? '')
    }
  };
  if (emailAttachment) body.attachments = [emailAttachment];

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(updateId != null ? { 'Idempotency-Key': `chuck-inbox-${updateId}` } : {})
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend failed ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
