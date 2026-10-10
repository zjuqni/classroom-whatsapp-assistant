'use strict';

function jid(value) {
  return String(typeof value === 'object' && value ? value._serialized : value || '').trim().toLowerCase();
}

function createMentionBot({ groupId, ownIds, getState, saveState, resolveSender, ask, sendReply, messagesPerHour = 10, now = Date.now, logger = console }) {
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
    while (active < 3 && waiting.length) {
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
    const timestamp = now();
    const recent = (bot.userWindows[sender] || []).filter(t => Number(t) > timestamp - 3600000);
    if (recent.length >= messagesPerHour) return null;
    recent.push(timestamp);
    bot.userWindows[sender] = recent;
    bot.handled[id] = { status: 'reserved', at: timestamp };
    await saveState();
    return { id, question, timestamp, messagesUsed: recent.length };
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
      try {
        text = await ask(request.question, request.id);
        if (typeof text !== 'string' || !text.trim()) throw new Error('Empty response.');
      } catch (error) {
        logger.error('Assistant query failed:', error.message);
        text = 'Classroom/Gemini is unavailable right now. Please try again later.';
      }
      // Persist before sending: reconnects must not send the same reply again.
      bot.handled[request.id] = { status: 'sending', at: now() };
      await saveState();
      const usage = `📊 Hourly request limit: ${request.messagesUsed}/${messagesPerHour}.`;
      await sendReply(message, `${text.trim().slice(0, 8800)}\n\n${usage}`);
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

module.exports = { createMentionBot, jid };
