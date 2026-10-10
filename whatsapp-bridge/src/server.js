const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const qrcode = require('qrcode-terminal');
const QRCodeGenerator = require('qrcode-terminal/vendor/QRCode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { createMentionBot, jid } = require('./mention-bot');

const PORT = Number(process.env.PORT || 3018);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'sent-events.json');
const TOKEN = process.env.BRIDGE_TOKEN || '';
const GROUP_ID = process.env.WA_GROUP_ID || '';
const CLASSROOM_BOT_URL = process.env.CLASSROOM_BOT_URL || '';
const MESSAGES_PER_HOUR = Number(process.env.WA_MESSAGES_PER_HOUR || 10);
const MAX_BODY = process.env.MAX_BODY_BYTES || '35000000';
const MAX_REMEMBERED_EVENTS = 10000;

if (TOKEN.length < 32) throw new Error('BRIDGE_TOKEN must contain at least 32 characters.');
if (!Number.isInteger(MESSAGES_PER_HOUR) || MESSAGES_PER_HOUR < 1) throw new Error('WA_MESSAGES_PER_HOUR must be a positive integer.');

let clientReady = false;
let sendQueue = Promise.resolve();
let stateWriteQueue = Promise.resolve();
const ownMentionIds = new Set();
const senderAliases = new Map();
let mentionBot;
let state = { sent: {}, partial: {}, bot: { handled: {}, userWindows: {} } };

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (!state || typeof state.sent !== 'object' || !state.sent) state = { sent: {}, partial: {} };
    if (!state.partial || typeof state.partial !== 'object') state.partial = {};
    if (!state.bot || typeof state.bot !== 'object') state.bot = { handled: {}, userWindows: {} };
    if (!state.bot.handled || typeof state.bot.handled !== 'object') state.bot.handled = {};
    if (!state.bot.userWindows || typeof state.bot.userWindows !== 'object') state.bot.userWindows = {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveState();
  }
}

async function saveState() {
  const entries = Object.entries(state.sent).slice(-MAX_REMEMBERED_EVENTS);
  state.sent = Object.fromEntries(entries);
  if (state.bot) {
    state.bot.handled = Object.fromEntries(Object.entries(state.bot.handled).slice(-MAX_REMEMBERED_EVENTS));
    for (const [sender, window] of Object.entries(state.bot.userWindows)) {
      const recent = window.filter(t => Number(t) > Date.now() - 3600000);
      if (recent.length) state.bot.userWindows[sender] = recent;
      else delete state.bot.userWindows[sender];
    }
  }
  const snapshot = JSON.stringify(state);
  const current = stateWriteQueue.then(async () => {
    const tmp = `${STATE_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.rename(tmp, STATE_FILE);
  });
  stateWriteQueue = current.catch(() => {});
  return current;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireToken(req, res, next) {
  const supplied = req.get('authorization') || '';
  const expected = `Bearer ${TOKEN}`;
  if (!safeEqual(supplied, expected)) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

function safeFilename(value) {
  return String(value || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 180) || 'file';
}

function splitReply(text, maxLength) {
  const chunks = [];
  let current = '';
  for (const paragraph of String(text).split('\n')) {
    const lines = paragraph.length <= maxLength
      ? [paragraph]
      : paragraph.match(new RegExp('.{1,' + maxLength + '}', 'g')) || [''];
    for (const line of lines) {
      const candidate = current ? current + '\n' + line : line;
      if (candidate.length > maxLength && current) {
        chunks.push(current);
        current = line;
      } else current = candidate;
    }
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

async function getTargetGroup() {
  if (!clientReady) throw new Error('WhatsApp is not connected yet.');
  if (!GROUP_ID) throw new Error('Set WA_GROUP_ID after querying /groups.');
  const chats = await client.getChats();
  const target = chats.find(chat => chat.isGroup && chat.id._serialized === GROUP_ID);
  if (!target) throw new Error('WA_GROUP_ID was not found among the linked groups.');
  return target;
}

async function deliver(payload) {
  if (state.sent[payload.eventId]) {
    return { duplicate: true, sentAt: state.sent[payload.eventId].sentAt };
  }

  const group = await getTargetGroup();
  const progress = state.partial[payload.eventId] || { textSent: false, attachmentsSent: [] };
  state.partial[payload.eventId] = progress;
  if (!progress.textSent) {
    // Keep Classroom links in the message while avoiding unreliable previews.
    await client.sendMessage(group.id._serialized, payload.text, { linkPreview: false });
    progress.textSent = true;
    await saveState();
  }

  for (const [index, item] of (payload.attachments || []).entries()) {
    if (progress.attachmentsSent.includes(index)) continue;
    const media = new MessageMedia(item.mimeType || 'application/octet-stream', item.base64, safeFilename(item.filename));
    await client.sendMessage(group.id._serialized, media, { sendMediaAsDocument: true });
    progress.attachmentsSent.push(index);
    await saveState();
  }

  state.sent[payload.eventId] = { sentAt: new Date().toISOString() };
  delete state.partial[payload.eventId];
  await saveState();
  return { duplicate: false, sentAt: state.sent[payload.eventId].sentAt };
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'classroom', dataPath: path.join(DATA_DIR, 'whatsapp-session') }),
  puppeteer: {
    headless: true,
    args: ['--disable-dev-shm-usage']
  }
});

client.on('qr', async code => {
  console.log('\nScan this QR from WhatsApp > Linked devices. Do not share it.');
  qrcode.generate(code, { small: true });
  try {
    const qr = new QRCodeGenerator(-1, qrcode.error);
    qr.addData(code);
    qr.make();
    const border = 4;
    const size = qr.getModuleCount() + border * 2;
    const squares = [];
    qr.modules.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) squares.push(`M${x + border},${y + border}h1v1h-1z`);
    }));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${squares.join('')}" fill="black"/></svg>`;
    const qrPath = path.join(DATA_DIR, 'whatsapp-qr.svg');
    await fs.writeFile(qrPath, svg, { mode: 0o600 });
    await fs.chmod(qrPath, 0o600);
    console.log('Temporary QR saved in DATA_DIR/whatsapp-qr.svg.');
  } catch (error) {
    console.error('Could not save the temporary QR:', error.message);
  }
});
client.on('ready', async () => {
  clientReady = true;
  const ownId = jid(client.info && client.info.wid);
  ownMentionIds.add(ownId);
  try {
    const pairs = await client.getContactLidAndPhone([ownId]);
    for (const pair of pairs) {
      if (pair.lid) ownMentionIds.add(jid(pair.lid));
      if (pair.pn) ownMentionIds.add(jid(pair.pn));
    }
  } catch (error) { console.error('Could not resolve account aliases:', error.message); }
  console.log('WhatsApp Web is connected.');
  if (!GROUP_ID) console.log('WA_GROUP_ID is missing. Query GET /groups and configure the selected group ID.');
});
client.on('authenticated', () => console.log('WhatsApp session authenticated.'));
client.on('auth_failure', message => { clientReady = false; console.error('Authentication failed:', message); });
client.on('disconnected', reason => { clientReady = false; console.error('WhatsApp disconnected:', reason); });

async function resolveSender(senderId) {
  if (senderAliases.has(senderId)) return senderAliases.get(senderId);
  let resolved = senderId;
  try {
    const pairs = await client.getContactLidAndPhone([senderId]);
    if (pairs[0] && pairs[0].pn) resolved = jid(pairs[0].pn);
  } catch (_) {}
  senderAliases.set(senderId, resolved);
  return resolved;
}

async function askClassroom(question, messageId) {
  const response = await fetch(CLASSROOM_BOT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, question, messageId, groupId: GROUP_ID }),
    signal: AbortSignal.timeout(260000),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`Classroom/Gemini HTTP ${response.status}.`);
  const result = await response.json();
  if (!result || result.ok !== true || typeof result.answer !== 'string' || !result.answer.trim()) {
    throw new Error((result && result.error) || 'The assistant returned an empty response.');
  }
  return result.answer;
}

client.on('message', message => {
  if (!clientReady || !CLASSROOM_BOT_URL || !mentionBot) return;
  void mentionBot(message).catch(error => console.error('Could not process a mention:', error.message));
});
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_BODY }));

app.get('/health', (_req, res) => res.json({
  ok: true,
  whatsappReady: clientReady,
  groupConfigured: Boolean(GROUP_ID),
  classroomBotConfigured: Boolean(CLASSROOM_BOT_URL),
  mentionRepliesEnabled: Boolean(GROUP_ID && CLASSROOM_BOT_URL)
}));

app.get('/groups', requireToken, async (_req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp is not connected yet.' });
  try {
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup).map(chat => ({ name: chat.name, id: chat.id._serialized }));
    res.json({ groups });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.post('/notify', requireToken, async (req, res) => {
  const { eventId, text, attachments = [] } = req.body || {};
  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 250) {
    return res.status(400).json({ error: 'eventId is required and must not exceed 250 characters.' });
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 60000) {
    return res.status(400).json({ error: 'text is required and must not exceed 60000 characters.' });
  }
  if (!Array.isArray(attachments) || attachments.length > 10) {
    return res.status(400).json({ error: 'attachments must be an array of up to 10 files.' });
  }
  for (const item of attachments) {
    if (!item || typeof item.base64 !== 'string' || item.base64.length > 15000000) {
      return res.status(400).json({ error: 'Each attachment must include base64 and be smaller than 11 MB.' });
    }
  }

  const payload = { eventId: eventId.trim(), text, attachments };
  const current = sendQueue.then(() => deliver(payload));
  sendQueue = current.catch(() => {});
  try {
    const result = await current;
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Delivery failed:', payload.eventId, error.message);
    res.status(503).json({ error: error.message });
  }
});

async function start() {
  await loadState();
  mentionBot = createMentionBot({
    groupId: GROUP_ID,
    ownIds: () => ownMentionIds,
    messagesPerHour: MESSAGES_PER_HOUR,
    getState: () => state.bot,
    saveState,
    resolveSender,
    ask: askClassroom,
    sendReply: (message, answer) => {
      const chunks = splitReply(answer, 3000);
      const current = sendQueue.then(async () => {
        await message.reply(chunks[0], GROUP_ID, { linkPreview: false, ignoreQuoteErrors: true });
        for (const chunk of chunks.slice(1)) await client.sendMessage(GROUP_ID, chunk, { linkPreview: false });
      });
      sendQueue = current.catch(() => {});
      return current;
    }
  });
  const server = app.listen(PORT, HOST, () => console.log(`Bridge listening on http://${HOST}:${PORT}`));
  server.requestTimeout = 300000;
  server.headersTimeout = 310000;
  await client.initialize();
}

start().catch(error => {
  console.error('Could not start the bridge:', error);
  process.exit(1);
});
