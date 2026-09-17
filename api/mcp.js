import { get, list } from '@vercel/blob';
import { createHash, timingSafeEqual } from 'node:crypto';

const SERVER_INFO = { name: 'Chuck Inbox', version: '1.0.0' };
const MODERN_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-11-25';

async function readJson(pathname, options = {}) {
  const result = await get(pathname, { access: 'private', ...options });
  if (!result || result.statusCode !== 200) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

async function validateToken(rawToken) {
  if (!rawToken) return false;
  const current = await readJson('mcp/current.json', { useCache: false });
  if (!current?.tokenHash) return false;

  const provided = createHash('sha256').update(String(rawToken)).digest();
  const expected = Buffer.from(current.tokenHash, 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) }
  };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

async function listInbox(date) {
  const chosenDate = validDate(date) ? date : new Date().toISOString().slice(0, 10);
  const prefix = `inbox/${chosenDate}/`;
  const items = [];
  let cursor;

  do {
    const result = await list({ prefix, cursor, limit: 250 });
    for (const blob of result.blobs.filter((b) => b.pathname.endsWith('/metadata.json'))) {
      try {
        const metadata = await readJson(blob.pathname);
        if (!metadata) continue;
        const id = blob.pathname.replace(/\/metadata\.json$/, '').split('/').pop();
        items.push({
          id,
          savedAt: metadata.savedAt,
          type: metadata.type,
          text: metadata.text,
          caption: metadata.caption,
          forwarded: metadata.forwarded,
          forwardOrigin: metadata.forwardOrigin ?? null,
          from: metadata.from ?? null,
          file: metadata.file ? {
            pathname: metadata.file.pathname,
            contentType: metadata.file.contentType,
            size: metadata.file.size
          } : null
        });
      } catch (error) {
        console.error('MCP list inbox item failed:', blob.pathname, error);
      }
    }
    cursor = result.cursor;
  } while (cursor);

  items.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
  return { date: chosenDate, count: items.length, items };
}

async function getInboxItem(date, id, includeFile = true) {
  if (!validDate(date)) throw new Error('date must be YYYY-MM-DD');
  if (!/^[a-zA-Z0-9._-]+$/.test(String(id || ''))) throw new Error('invalid item id');

  const metadata = await readJson(`inbox/${date}/${id}/metadata.json`);
  if (!metadata) return null;

  const item = {
    id,
    savedAt: metadata.savedAt,
    type: metadata.type,
    text: metadata.text,
    caption: metadata.caption,
    forwarded: metadata.forwarded,
    forwardOrigin: metadata.forwardOrigin ?? null,
    from: metadata.from ?? null,
    file: metadata.file ? {
      pathname: metadata.file.pathname,
      contentType: metadata.file.contentType,
      size: metadata.file.size
    } : null
  };

  if (!includeFile || !metadata.file?.pathname) return { item, contents: [] };

  const file = await get(metadata.file.pathname, { access: 'private' });
  if (!file || file.statusCode !== 200) return { item, contents: [] };

  const contentType = metadata.file.contentType || file.blob?.contentType || 'application/octet-stream';
  const maxEmbed = 8 * 1024 * 1024;
  const size = Number(metadata.file.size || 0);

  if (contentType.startsWith('image/') && size <= maxEmbed) {
    const buffer = Buffer.from(await new Response(file.stream).arrayBuffer());
    return {
      item,
      contents: [{ type: 'image', data: buffer.toString('base64'), mimeType: contentType }]
    };
  }

  return {
    item,
    contents: [{
      type: 'text',
      text: `Файл сохранён в Chuck Inbox. Тип: ${contentType}. Размер: ${size || 'неизвестен'} байт. Встроенная передача сейчас включена только для изображений до 8 МБ.`
    }]
  };
}

const tools = [
  {
    name: 'list_inbox',
    description: 'Показывает материалы, сохранённые в Chuck Inbox из Telegram за выбранную дату. Если дата не указана, используется сегодняшняя дата UTC.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата в формате YYYY-MM-DD' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_inbox_item',
    description: 'Возвращает метаданные конкретного элемента Chuck Inbox и, если это изображение до 8 МБ, само изображение.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
        id: { type: 'string', description: 'ID элемента из list_inbox' }
      },
      required: ['date', 'id'],
      additionalProperties: false
    }
  }
];

async function callTool(name, args = {}) {
  if (name === 'list_inbox') {
    const result = await listInbox(args.date);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result
    };
  }

  if (name === 'get_inbox_item') {
    const result = await getInboxItem(args.date, args.id, true);
    if (!result) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Элемент не найден.' }]
      };
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify(result.item, null, 2) },
        ...result.contents
      ],
      structuredContent: result.item
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Неизвестный инструмент: ${name}` }]
  };
}

function discoverResult() {
  return {
    protocolVersion: MODERN_PROTOCOL,
    serverInfo: SERVER_INFO,
    capabilities: { tools: {} }
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-protocol-version, mcp-method, mcp-name');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const rawToken = req.query?.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await validateToken(rawToken))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'Chuck Inbox MCP',
      protocolVersion: MODERN_PROTOCOL,
      tools: tools.map(({ name, description }) => ({ name, description }))
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const id = body.id;
  const method = body.method || req.headers['mcp-method'];

  try {
    if (method === 'server/discover') {
      return res.status(200).json(jsonRpcResult(id, discoverResult()));
    }

    if (method === 'initialize') {
      const requested = body.params?.protocolVersion;
      const protocolVersion = requested === LEGACY_PROTOCOL ? LEGACY_PROTOCOL : (requested || LEGACY_PROTOCOL);
      return res.status(200).json(jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }));
    }

    if (method === 'notifications/initialized') {
      return res.status(202).end();
    }

    if (method === 'tools/list') {
      return res.status(200).json(jsonRpcResult(id, { tools }));
    }

    if (method === 'tools/call') {
      const name = body.params?.name || req.headers['mcp-name'];
      const args = body.params?.arguments || {};
      const result = await callTool(name, args);
      return res.status(200).json(jsonRpcResult(id, result));
    }

    return res.status(200).json(jsonRpcError(id, -32601, `Method not found: ${method}`));
  } catch (error) {
    console.error('Chuck Inbox MCP error:', error);
    return res.status(200).json(jsonRpcError(id, -32603, 'Internal error', String(error?.message || error)));
  }
}
