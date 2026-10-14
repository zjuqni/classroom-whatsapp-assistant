'use strict';

function jid(value) {
  return String(typeof value === 'object' && value ? value._serialized : value || '').trim().toLowerCase();
}

const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_ITEMS = 25;
const MEMORY_MAX_CHARS = 60000;
const MEMORY_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'what', 'when', 'where', 'which', 'who', 'this', 'that', 'que', 'para', 'por', 'con', 'del', 'las', 'los', 'una', 'uno', 'como', 'hay', 'fue', 'son', 'esta', 'este', 'eso', 'esa']);

function memoryTokens(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(token => token.length >= 3 && !MEMORY_STOP_WORDS.has(token));
}

function relevantHistory(history, question, timestamp) {
  const usable = (Array.isArray(history) ? history : []).filter(item => item && item.ok !== false && Number(item.at) >= timestamp - MEMORY_TTL_MS)
    .slice().sort((a, b) => Number(a.at) - Number(b.at));
  const recent = usable.slice(-6);
  const terms = new Set(memoryTokens(question));
  const ranked = usable.map(item => {
    const tokens = new Set(memoryTokens(`${item.question || ''} ${String(item.answer || '').slice(0, 2400)}`));
    let score = 0;
    for (const term of terms) if (tokens.has(term)) score++;
    return { item, score };
  }).filter(entry => entry.score > 0 && !recent.includes(entry.item))
    .sort((a, b) => b.score - a.score || Number(b.item.at) - Number(a.item.at));
  const selected = new Set(recent);
  let chars = recent.reduce((total, item) => total + Math.min(2000, String(item.question || '').length) + Math.min(8000, String(item.answer || '').length), 0);
  for (const entry of ranked) {
    if (selected.size >= MEMORY_MAX_ITEMS) break;
    const size = Math.min(2000, String(entry.item.question || '').length) + Math.min(8000, String(entry.item.answer || '').length);
    if (chars + size > MEMORY_MAX_CHARS) continue;
    selected.add(entry.item);
    chars += size;
  }
  return usable.filter(item => selected.has(item)).map(item => ({
    at: Number(item.at), senderName: String(item.senderName || '').slice(0, 80),
    question: String(item.question || '').slice(0, 2000), answer: String(item.answer || '').slice(0, 8000)
  }));
}

function createMentionBot({ groupId, ownIds, getState, saveState, resolveSender, resolveSenderName = async () => '', ask, sendReply, messagesPerHour = 10, now = Date.now, logger = console }) {
  if (!Number.isInteger(messagesPerHour) || messagesPerHour < 1) throw new Error('messagesPerHour must be a positive integer.');
  const startedAt = now();
  let admissionQueue = Promise.resolve();
  let active = 0;
  const waiting = [];

  function schedule(task) {
    return new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      pump();
    });
  }

  function pump() {
    // Shared history is ordered so a new answer can refer to earlier turns.
    while (active < 1 && waiting.length) {
      const job = waiting.shift();
      active++;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }

  async function reserve(message) {
    if (message.fromMe || message.from !== groupId || !message.author) return null;
    const mentions = (message.mentionedIds || []).map(jid);
    if (!mentions.some(id => ownIds().has(id))) return null;
    if (!message.timestamp || Number(message.timestamp) * 1000 < startedAt - 15000) return null;
    const id = message.id && message.id._serialized;
    const bot = getState();
    if (!id || bot.handled[id]) return null;
    let question = String(message.body || '');
    for (const mentioned of mentions) question = question.replaceAll('@' + mentioned.split('@')[0], ' ');
    question = question.trim().slice(0, 4000);
    if (!question) return null;
    const sender = await resolveSender(jid(message.author));
    const senderName = String(await resolveSenderName(message, jid(message.author)) || '')
      .replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 80);
    const timestamp = now();
    const recent = (bot.userWindows[sender] || []).filter(t => Number(t) > timestamp - 3600000);
    if (recent.length >= messagesPerHour) return null;
    recent.push(timestamp);
    bot.userWindows[sender] = recent;
    bot.handled[id] = { status: 'reserved', at: timestamp };
    await saveState();
    return { id, question, timestamp, sender, senderName, messagesUsed: recent.length };
  }

  async function answer(message, request) {
    const bot = getState();
    try {
      if (now() - request.timestamp > 600000) {
        bot.handled[request.id] = { status: 'expired', at: now() };
        await saveState();
        return;
      }
      let text;
      let queryOk = true;
      try {
        const history = relevantHistory(bot.groupHistory, request.question, now());
        text = await ask(request.question, request.id, { senderId: request.sender, senderName: request.senderName, history });
        if (typeof text !== 'string' || !text.trim()) throw new Error('Empty response.');
      } catch (error) {
        queryOk = false;
        logger.error('Assistant query failed:', error.message);
        text = 'Classroom/Gemini is unavailable right now. Please try again later.';
      }
      // Persist before sending: reconnects must not send the same reply again.
      bot.handled[request.id] = { status: 'sending', at: now() };
      await saveState();
      const usage = `📊 Hourly request limit: ${request.messagesUsed}/${messagesPerHour}.`;
      await sendReply(message, `${text.trim().slice(0, 8800)}\n\n${usage}`);
      if (!Array.isArray(bot.groupHistory)) bot.groupHistory = [];
      bot.groupHistory.push({ at: now(), senderId: request.sender, senderName: request.senderName,
        question: request.question, answer: text.trim().slice(0, 9000), ok: queryOk });
      bot.groupHistory = bot.groupHistory.filter(item => Number(item.at) >= now() - MEMORY_TTL_MS);
      bot.handled[request.id] = { status: 'answered', at: now() };
    } catch (error) {
      bot.handled[request.id] = { status: 'failed', at: now() };
      logger.error('WhatsApp reply failed:', error.message);
    }
    await saveState();
  }

  return async function handle(message) {
    const admitted = admissionQueue.then(() => reserve(message));
    admissionQueue = admitted.catch(() => {});
    const request = await admitted;
    if (request) await schedule(() => answer(message, request));
  };
}

module.exports = { createMentionBot, jid, relevantHistory, MEMORY_TTL_MS };
