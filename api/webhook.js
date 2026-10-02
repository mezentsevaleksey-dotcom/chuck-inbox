import { createHash } from 'node:crypto';
import { makeEmailAttachment, sendToGmail } from './emailBridge.js';

const PACKAGE_WINDOW_MS = 10 * 60 * 1000;

function classifyMessage(message) {
  if (message.photo?.length) {
    return { type: 'photo', file: message.photo.at(-1), label: 'Фото' };
  }
  if (message.video) {
    return { type: 'video', file: message.video, label: 'Видео' };
  }
  if (message.video_note) {
    return { type: 'video_note', file: message.video_note, label: 'Видеосообщение' };
  }
  if (message.document) {
    return { type: 'document', file: message.document, label: 'Документ' };
  }
  if (message.voice) {
    return { type: 'voice', file: message.voice, label: 'Голосовое' };
  }
  if (message.audio) {
    return { type: 'audio', file: message.audio, label: 'Аудио' };
  }
  if (message.animation) {
    return { type: 'animation', file: message.animation, label: 'Анимация' };
  }
  if (message.sticker) {
    return { type: 'sticker', file: message.sticker, label: 'Стикер' };
  }

  if (message.text || message.caption) {
    const text = message.text || message.caption || '';
    const hasUrl = /(https?:\/\/|www\.)\S+/i.test(text);

    return {
      type: hasUrl ? 'link' : 'text',
      file: null,
      label: hasUrl ? 'Ссылка' : 'Текст'
    };
  }

  return {
    type: 'other',
    file: null,
    label: 'Сообщение'
  };
}

async function telegramApi(token, method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `${method} failed: ${JSON.stringify(data)}`
    );
  }

  return data.result;
}

function resolvePackage(message) {
  const messageMs = message.date
    ? message.date * 1000
    : Date.now();

  const bucketMs =
    Math.floor(messageMs / PACKAGE_WINDOW_MS) *
    PACKAGE_WINDOW_MS;

  const bucket = new Date(bucketMs);
  const startedAt = bucket.toISOString();
  const date = startedAt.slice(0, 10);

  const stamp = startedAt
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

  const chatHash = createHash('sha256')
    .update(String(message.chat.id))
    .digest('hex')
    .slice(0, 10);

  return {
    packageId: `${stamp}-${chatHash}`,
    date,
    startedAt,
    lastActivityAt: new Date(messageMs).toISOString()
  };
}

function inferredMime(
  type,
  filename,
  telegramMime,
  responseMime
) {
  if (telegramMime) return telegramMime;

  const lower = String(filename || '').toLowerCase();

  if (
    type === 'photo' ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg')
  ) {
    return 'image/jpeg';
  }

  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';

  if (
    type === 'video' ||
    type === 'video_note' ||
    lower.endsWith('.mp4')
  ) {
    return 'video/mp4';
  }

  if (
    type === 'voice' ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.oga')
  ) {
    return 'audio/ogg';
  }

  if (
    type === 'audio' &&
    lower.endsWith('.mp3')
  ) {
    return 'audio/mpeg';
  }

  if (
    responseMime &&
    responseMime !== 'application/octet-stream'
  ) {
    return responseMime;
  }

  return 'application/octet-stream';
}

async function downloadTelegramFile(
  token,
  file,
  type
) {
  if (!file?.file_id) {
    return {
      metadata: null,
      emailAttachment: null
    };
  }

  const info = await telegramApi(
    token,
    'getFile',
    { file_id: file.file_id }
  );

  if (!info?.file_path) {
    return {
      metadata: null,
      emailAttachment: null
    };
  }

  const download = await fetch(
    `https://api.telegram.org/file/bot${token}/${info.file_path}`
  );

  if (!download.ok) {
    throw new Error(
      `Telegram file download failed: ${download.status}`
    );
  }

  const buffer = await download.arrayBuffer();

  const originalName =
    file.file_name ||
    info.file_path.split('/').pop() ||
    'file';

  const responseMime =
    download.headers.get('content-type');

  const contentType = inferredMime(
    type,
    originalName,
    file.mime_type,
    responseMime
  );

  const metadata = {
    pathname: null,
    contentType,
    size: buffer.byteLength,
    fileName: file.file_name || originalName,
    telegramFileId: file.file_id,
    telegramFileUniqueId:
      file.file_unique_id ?? null,
    duration: file.duration ?? null,
    width: file.width ?? null,
    height: file.height ?? null
  };

  return {
    metadata,
    emailAttachment: makeEmailAttachment(
      buffer,
      metadata.fileName,
      contentType
    )
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'Chuck Inbox',
      version: '1.7',
      emailBridge: true,
      blobStorage: false,
      packageWindowSeconds:
        PACKAGE_WINDOW_MS / 1000
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  const token =
    process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: 'Telegram bot is not configured'
    });
  }

  const update = req.body || {};

  const message =
    update.message ||
    update.edited_message ||
    update.channel_post;

  if (!message?.chat?.id) {
    return res.status(200).json({
      ok: true,
      ignored: true
    });
  }

  const allowedUserId =
    process.env.ALLOWED_TELEGRAM_USER_ID;

  if (
    allowedUserId &&
    String(message.from?.id || '') !==
      String(allowedUserId)
  ) {
    return res.status(200).json({
      ok: true,
      ignored: true
    });
  }

  const classification =
    classifyMessage(message);

  try {
    const pkg = resolvePackage(message);

    const saved = classification.file
      ? await downloadTelegramFile(
          token,
          classification.file,
          classification.type
        )
      : {
          metadata: null,
          emailAttachment: null
        };

    const sent = await sendToGmail({
      message,
      classification,
      pkg,
      savedFile: saved.metadata,
      emailAttachment:
        saved.emailAttachment,
      updateId: update.update_id
    });

    await telegramApi(
      token,
      'sendMessage',
      {
        chat_id: message.chat.id,
        text:
          `Отправил в Gmail ✅ ${classification.label}`,
        reply_to_message_id:
          message.message_id,
        allow_sending_without_reply: true
      }
    );

    return res.status(200).json({
      ok: true,
      emailed: true,
      emailId: sent?.id ?? null,
      type: classification.type,
      packageId: pkg.packageId
    });
  } catch (error) {
    console.error(
      'Chuck Inbox failed:',
      error
    );

    try {
      await telegramApi(
        token,
        'sendMessage',
        {
          chat_id: message.chat.id,
          text:
            'Получил, но не смог отправить в Gmail ⚠️',
          reply_to_message_id:
            message.message_id,
          allow_sending_without_reply: true
        }
      );
    } catch {}

    return res.status(200).json({
      ok: true,
      emailed: false,
      error: String(
        error?.message || error
      )
    });
  }
}
