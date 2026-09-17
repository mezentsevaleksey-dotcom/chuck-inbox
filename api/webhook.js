import { get, put } from '@vercel/blob';
import { createHash, randomBytes } from 'node:crypto';

const PACKAGE_IDLE_MS = 3 * 60 * 1000;

function classifyMessage(message) {
  if (message.photo?.length) return { type: 'photo', file: message.photo.at(-1), label: 'Фото' };
  if (message.video) return { type: 'video', file: message.video, label: 'Видео' };
  if (message.video_note) return { type: 'video_note', file: message.video_note, label: 'Видеосообщение' };
  if (message.document) return { type: 'document', file: message.document, label: 'Документ' };
  if (message.voice) return { type: 'voice', file: message.voice, label: 'Голосовое' };
  if (message.audio) return { type: 'audio', file: message.audio, label: 'Аудио' };
  if (message.animation) return { type: 'animation', file: message.animation, label: 'Анимация' };
  if (message.sticker) return { type: 'sticker', file: message.sticker, label: 'Стикер' };
  if (message.text || message.caption) {
    const text = message.text || message.caption || '';
    const hasUrl = /(https?:\/\/|www\.)\S+/i.test(text);
    return { type: hasUrl ? 'link' : 'text', file: null, label: hasUrl ? 'Ссылка' : 'Текст' };
  }
  return { type: 'other', file: null, label: 'Сообщение' };
}

async function telegramApi(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

function safeName(name = '') {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

function requestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function readJson(pathname) {
  try {
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return JSON.parse(await new Response(result.stream).text());
  } catch {
    return null;
  }
}

function newPackageId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomBytes(5).toString('hex')}`;
}

async function resolvePackage(message) {
  const now = new Date();
  const nowIso = now.toISOString();
  const chatId = String(message.chat.id);
  const pointerPath = `packages/current/${safeName(chatId)}.json`;
  const current = await readJson(pointerPath);

  const currentLast = current?.lastActivityAt ? new Date(current.lastActivityAt).getTime() : 0;
  const samePackage = Boolean(
    current?.packageId &&
    current?.date &&
    currentLast &&
    now.getTime() - currentLast <= PACKAGE_IDLE_MS
  );

  const pkg = samePackage
    ? {
        packageId: current.packageId,
        date: current.date,
        startedAt: current.startedAt || nowIso,
        lastActivityAt: nowIso
      }
    : {
        packageId: newPackageId(now),
        date: nowIso.slice(0, 10),
        startedAt: nowIso,
        lastActivityAt: nowIso
      };

  await put(pointerPath, JSON.stringify({
    ...pkg,
    chatId: message.chat.id,
    updatedAt: nowIso,
    inactivityWindowSeconds: PACKAGE_IDLE_MS / 1000
  }, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60
  });

  await put(`packages/${pkg.date}/${pkg.packageId}/status.json`, JSON.stringify({
    ...pkg,
    chatId: message.chat.id,
    status: 'open',
    inactivityWindowSeconds: PACKAGE_IDLE_MS / 1000
  }, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60
  });

  return pkg;
}

async function createShareLink(req, message) {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 30 * 60 * 1000);

  const record = {
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    userId: message.from?.id ?? null,
    chatId: message.chat?.id ?? null
  };

  await put(`shares/${tokenHash}.json`, JSON.stringify(record), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false
  });

  const date = new Date().toISOString().slice(0, 10);
  return `${requestOrigin(req)}/api/inbox?token=${encodeURIComponent(rawToken)}&date=${date}`;
}

async function createMcpLink(req, message) {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const record = {
    tokenHash,
    createdAt: new Date().toISOString(),
    userId: message.from?.id ?? null,
    chatId: message.chat?.id ?? null
  };

  await put('mcp/current.json', JSON.stringify(record, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });

  return `${requestOrigin(req)}/api/mcp?token=${encodeURIComponent(rawToken)}`;
}

async function saveTelegramFile(token, file, basePath) {
  const fileId = file.file_id;
  if (!fileId) return null;

  const info = await telegramApi(token, 'getFile', { file_id: fileId });
  if (!info?.file_path) return null;

  const download = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
  if (!download.ok) throw new Error(`Telegram file download failed: ${download.status}`);

  const buffer = await download.arrayBuffer();
  const originalName = file.file_name || info.file_path.split('/').pop() || 'file';
  const extName = safeName(originalName);
  const contentType = file.mime_type || download.headers.get('content-type') || 'application/octet-stream';

  const blob = await put(`${basePath}/${extName}`, buffer, {
    access: 'private',
    contentType,
    addRandomSuffix: true
  });

  return {
    pathname: blob.pathname,
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    contentType,
    size: buffer.byteLength,
    telegramFileId: fileId,
    telegramFileUniqueId: file.file_unique_id ?? null,
    fileName: file.file_name ?? originalName,
    duration: file.duration ?? null,
    width: file.width ?? null,
    height: file.height ?? null
  };
}

async function saveMetadata(message, update, classification, savedFile, basePath, pkg) {
  const metadata = {
    savedAt: new Date().toISOString(),
    updateId: update.update_id ?? null,
    messageId: message.message_id ?? null,
    mediaGroupId: message.media_group_id ?? null,
    package: {
      id: pkg.packageId,
      date: pkg.date,
      startedAt: pkg.startedAt,
      lastActivityAt: pkg.lastActivityAt,
      inactivityWindowSeconds: PACKAGE_IDLE_MS / 1000
    },
    date: message.date ?? null,
    chat: {
      id: message.chat?.id ?? null,
      type: message.chat?.type ?? null,
      title: message.chat?.title ?? null
    },
    from: {
      id: message.from?.id ?? null,
      username: message.from?.username ?? null,
      firstName: message.from?.first_name ?? null,
      lastName: message.from?.last_name ?? null
    },
    forwarded: Boolean(message.forward_origin || message.forward_from || message.forward_sender_name),
    forwardOrigin: message.forward_origin ?? null,
    replyTo: message.reply_to_message ? {
      messageId: message.reply_to_message.message_id ?? null,
      text: message.reply_to_message.text ?? message.reply_to_message.caption ?? null,
      from: message.reply_to_message.from ? {
        id: message.reply_to_message.from.id ?? null,
        username: message.reply_to_message.from.username ?? null,
        firstName: message.reply_to_message.from.first_name ?? null,
        lastName: message.reply_to_message.from.last_name ?? null
      } : null
    } : null,
    type: classification.type,
    text: message.text ?? null,
    caption: message.caption ?? null,
    entities: message.entities ?? message.caption_entities ?? null,
    file: savedFile
  };

  await put(`${basePath}/metadata.json`, JSON.stringify(metadata, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'Chuck Inbox', version: '1.4', packageIdleSeconds: PACKAGE_IDLE_MS / 1000 });
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
  const command = String(message.text || '').trim().toLowerCase();

  if (command === '/share' || command === 'share' || command === 'ссылка для чата') {
    try {
      const shareUrl = await createShareLink(req, message);
      await telegramApi(token, 'sendMessage', {
        chat_id: chatId,
        text: `Временная ссылка для разбора материалов (30 минут):\n${shareUrl}`,
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
        disable_web_page_preview: true
      });
      return res.status(200).json({ ok: true, shared: true });
    } catch (error) {
      console.error('Chuck Inbox share link failed:', error);
      await telegramApi(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не смог создать временную ссылку ⚠️',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true
      });
      return res.status(200).json({ ok: true, shared: false });
    }
  }

  if (command === '/mcpkey' || command === '/mcp' || command === 'подключить chatgpt') {
    try {
      const mcpUrl = await createMcpLink(req, message);
      await telegramApi(token, 'sendMessage', {
        chat_id: chatId,
        text: `Адрес Chuck Inbox для подключения к ChatGPT:\n${mcpUrl}\n\nНе отправляй эту ссылку в обычные чаты. Новая команда /mcpkey автоматически отключит предыдущую ссылку.`,
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
        disable_web_page_preview: true
      });
      return res.status(200).json({ ok: true, mcp: true });
    } catch (error) {
      console.error('Chuck Inbox MCP link failed:', error);
      await telegramApi(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Не смог создать ссылку для подключения ChatGPT ⚠️',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true
      });
      return res.status(200).json({ ok: true, mcp: false });
    }
  }

  const classification = classifyMessage(message);

  try {
    const pkg = await resolvePackage(message);
    const unique = `${String(message.message_id ?? 'm').padStart(10, '0')}-${Date.now()}-${update.update_id ?? 'u'}`;
    const basePath = `inbox/${pkg.date}/${pkg.packageId}/${unique}`;

    const savedFile = classification.file
      ? await saveTelegramFile(token, classification.file, basePath)
      : null;

    await saveMetadata(message, update, classification, savedFile, basePath, pkg);

    await telegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `Сохранил ✅ ${classification.label}`,
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true
    });

    return res.status(200).json({
      ok: true,
      saved: true,
      type: classification.type,
      packageId: pkg.packageId
    });
  } catch (error) {
    console.error('Chuck Inbox save failed:', error);

    try {
      await telegramApi(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Получил, но не смог сохранить ⚠️',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true
      });
    } catch (notifyError) {
      console.error('Failed to notify Telegram user:', notifyError);
    }

    return res.status(200).json({ ok: true, saved: false, error: String(error?.message || error) });
  }
}
