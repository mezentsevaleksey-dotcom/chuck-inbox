import { get, put } from '@vercel/blob';
import { randomBytes } from 'node:crypto';
import { makeEmailAttachment, sendToGmail } from './emailBridge.js';

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
  if (!response.ok || !data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

function safeName(name = '') {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
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
  const last = current?.lastActivityAt ? new Date(current.lastActivityAt).getTime() : 0;
  const reuse = Boolean(current?.packageId && current?.date && last && now.getTime() - last <= PACKAGE_IDLE_MS);

  const pkg = reuse
    ? { packageId: current.packageId, date: current.date, startedAt: current.startedAt || nowIso, lastActivityAt: nowIso }
    : { packageId: newPackageId(now), date: nowIso.slice(0, 10), startedAt: nowIso, lastActivityAt: nowIso };

  await put(pointerPath, JSON.stringify({ ...pkg, chatId: message.chat.id, inactivityWindowSeconds: 180 }, null, 2), {
    access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true
  });

  await put(`packages/${pkg.date}/${pkg.packageId}/status.json`, JSON.stringify({ ...pkg, chatId: message.chat.id, status: 'open', inactivityWindowSeconds: 180 }, null, 2), {
    access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true
  });

  return pkg;
}

function inferredMime(type, filename, telegramMime, responseMime) {
  if (telegramMime) return telegramMime;
  const lower = String(filename || '').toLowerCase();
  if (type === 'photo' || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (type === 'video' || type === 'video_note' || lower.endsWith('.mp4')) return 'video/mp4';
  if (type === 'voice' || lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (type === 'audio' && lower.endsWith('.mp3')) return 'audio/mpeg';
  if (responseMime && responseMime !== 'application/octet-stream') return responseMime;
  return 'application/octet-stream';
}

async function saveTelegramFile(token, file, basePath, type) {
  if (!file?.file_id) return { metadata: null, emailAttachment: null };
  const info = await telegramApi(token, 'getFile', { file_id: file.file_id });
  if (!info?.file_path) return { metadata: null, emailAttachment: null };

  const download = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
  if (!download.ok) throw new Error(`Telegram file download failed: ${download.status}`);
  const buffer = await download.arrayBuffer();
  const originalName = file.file_name || info.file_path.split('/').pop() || 'file';
  const responseMime = download.headers.get('content-type');
  const contentType = inferredMime(type, originalName, file.mime_type, responseMime);
  const blob = await put(`${basePath}/${safeName(originalName)}`, buffer, { access: 'private', contentType, addRandomSuffix: true });

  const metadata = {
    pathname: blob.pathname,
    contentType,
    size: buffer.byteLength,
    fileName: file.file_name || originalName,
    telegramFileId: file.file_id,
    telegramFileUniqueId: file.file_unique_id ?? null,
    duration: file.duration ?? null,
    width: file.width ?? null,
    height: file.height ?? null
  };

  return {
    metadata,
    emailAttachment: makeEmailAttachment(buffer, metadata.fileName, contentType)
  };
}

async function saveMetadata(message, update, classification, savedFile, basePath, pkg, email) {
  const metadata = {
    savedAt: new Date().toISOString(),
    updateId: update.update_id ?? null,
    messageId: message.message_id ?? null,
    mediaGroupId: message.media_group_id ?? null,
    package: { id: pkg.packageId, date: pkg.date, startedAt: pkg.startedAt, lastActivityAt: pkg.lastActivityAt },
    chat: { id: message.chat?.id ?? null, type: message.chat?.type ?? null, title: message.chat?.title ?? null },
    from: { id: message.from?.id ?? null, username: message.from?.username ?? null, firstName: message.from?.first_name ?? null, lastName: message.from?.last_name ?? null },
    forwarded: Boolean(message.forward_origin || message.forward_from || message.forward_sender_name),
    forwardOrigin: message.forward_origin ?? null,
    replyTo: message.reply_to_message ? {
      messageId: message.reply_to_message.message_id ?? null,
      text: message.reply_to_message.text ?? message.reply_to_message.caption ?? null
    } : null,
    type: classification.type,
    text: message.text ?? null,
    caption: message.caption ?? null,
    entities: message.entities ?? message.caption_entities ?? null,
    file: savedFile,
    email
  };

  await put(`${basePath}/metadata.json`, JSON.stringify(metadata, null, 2), {
    access: 'private', contentType: 'application/json', addRandomSuffix: false
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'Chuck Inbox', version: '1.6', emailBridge: true, packageIdleSeconds: 180 });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'Telegram bot is not configured' });

  const update = req.body || {};
  const message = update.message || update.edited_message || update.channel_post;
  if (!message?.chat?.id) return res.status(200).json({ ok: true, ignored: true });

  const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID;
  if (allowedUserId && String(message.from?.id || '') !== String(allowedUserId)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const classification = classifyMessage(message);

  try {
    const pkg = await resolvePackage(message);
    const unique = `${String(message.message_id ?? 'm').padStart(10, '0')}-${Date.now()}-${update.update_id ?? 'u'}`;
    const basePath = `inbox/${pkg.date}/${pkg.packageId}/${unique}`;
    const saved = classification.file
      ? await saveTelegramFile(token, classification.file, basePath, classification.type)
      : { metadata: null, emailAttachment: null };

    let email;
    try {
      const sent = await sendToGmail({
        message,
        classification,
        pkg,
        savedFile: saved.metadata,
        emailAttachment: saved.emailAttachment,
        updateId: update.update_id
      });
      email = { sent: true, id: sent?.id ?? null, sentAt: new Date().toISOString() };
    } catch (error) {
      console.error('Email bridge failed:', error);
      email = { sent: false, error: String(error?.message || error), failedAt: new Date().toISOString() };
    }

    await saveMetadata(message, update, classification, saved.metadata, basePath, pkg, email);

    await telegramApi(token, 'sendMessage', {
      chat_id: message.chat.id,
      text: email.sent
        ? `Сохранил и отправил в Gmail ✅ ${classification.label}`
        : `Сохранил ✅ ${classification.label}\nНо в Gmail отправить не удалось ⚠️`,
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true
    });

    return res.status(200).json({ ok: true, saved: true, emailed: email.sent, type: classification.type, packageId: pkg.packageId });
  } catch (error) {
    console.error('Chuck Inbox failed:', error);
    try {
      await telegramApi(token, 'sendMessage', {
        chat_id: message.chat.id,
        text: 'Получил, но не смог сохранить ⚠️',
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true
      });
    } catch {}
    return res.status(200).json({ ok: true, saved: false, error: String(error?.message || error) });
  }
}
