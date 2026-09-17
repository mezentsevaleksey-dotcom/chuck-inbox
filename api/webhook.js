export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'Chuck Inbox' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' });
  }

  const update = req.body || {};
  const message = update.message || update.edited_message || update.channel_post;

  if (!message?.chat?.id) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID;
  if (allowedUserId && String(message.from?.id || '') !== String(allowedUserId)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const chatId = message.chat.id;
  const firstName = message.from?.first_name || '';
  const text = firstName ? `Получил ✅, ${firstName}` : 'Получил ✅';

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true
    })
  });

  if (!response.ok) {
    const details = await response.text();
    console.error('Telegram sendMessage failed:', details);
  }

  return res.status(200).json({ ok: true });
}
