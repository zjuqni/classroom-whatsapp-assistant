'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMentionBot, relevantHistory, MEMORY_TTL_MS } = require('../src/mention-bot');

function setup(existing, messagesPerHour = 10) {
  let clock = 1800000000000;
  const state = existing || { handled: {}, userWindows: {}, groupHistory: [] };
  const replies = [];
  const questions = [];
  const contexts = [];
  let persistCount = 0;
  const bot = createMentionBot({
    messagesPerHour,
    groupId: 'class@g.us', ownIds: () => new Set(['bot@c.us', 'bot@lid']),
    getState: () => state, saveState: async () => { persistCount++; },
    resolveSender: async sender => sender === 'student@lid' ? 'student@c.us' : sender,
    resolveSenderName: async message => message._data && message._data.notifyName || '',
    ask: async (question, _id, context) => { questions.push(question); contexts.push(context); return 'Answer'; },
    sendReply: async (message, text) => { replies.push({ id: message.id._serialized, text }); },
    now: () => clock, logger: { error() {} }
  });
  return { bot, state, replies, questions, contexts, get persistCount() { return persistCount; }, advance(ms) { clock += ms; },
    message(id, author = 'student@c.us', overrides = {}) { return { from: 'class@g.us', author, id: { _serialized: id }, body: '@bot What assignments are there?', mentionedIds: ['bot@c.us'], timestamp: clock / 1000, fromMe: false, ...overrides }; } };
}

test('only handles recent direct mentions from the configured group', async () => {
  const s = setup();
  await s.bot(s.message('other', undefined, { from: 'other@g.us' }));
  await s.bot(s.message('private', undefined, { from: 'student@c.us' }));
  await s.bot(s.message('unmentioned', undefined, { mentionedIds: [] }));
  await s.bot(s.message('old', undefined, { timestamp: 1 }));
  await s.bot(s.message('self', undefined, { fromMe: true }));
  await s.bot(s.message('empty', undefined, { body: '@bot' }));
  assert.equal(s.replies.length, 0);
  await s.bot(s.message('valid', undefined, { mentionedIds: ['bot@lid'], body: '@bot What assignments are there?' }));
  assert.equal(s.replies.length, 1);
  assert.equal(s.questions[0], 'What assignments are there?');
});

test('concurrent duplicate events generate one reply', async () => {
  const s = setup();
  await Promise.all([s.bot(s.message('same')), s.bot(s.message('same')), s.bot(s.message('same'))]);
  assert.equal(s.replies.length, 1);
  assert.equal(s.state.handled.same.status, 'answered');
  assert.ok(s.persistCount >= 3);
});

test('limits each user to ten requests, including concurrency and LID aliases', async () => {
  const s = setup();
  await Promise.all(Array.from({ length: 12 }, (_, i) => s.bot(s.message('q' + i, i % 2 ? 'student@lid' : 'student@c.us'))));
  assert.equal(s.replies.length, 10);
  await s.bot(s.message('other-user', 'other@c.us'));
  assert.equal(s.replies.length, 11);
  s.advance(3600001);
  await s.bot(s.message('after-hour'));
  assert.equal(s.replies.length, 12);
});

test('the same quota applies to every account and display name', async () => {
  const s = setup();
  await Promise.all(Array.from({ length: 12 }, (_, i) => s.bot(s.message('owner' + i, 'owner@c.us'))));
  await Promise.all(Array.from({ length: 12 }, (_, i) => s.bot(s.message('fake' + i, 'fake@c.us', { _data: { notifyName: 'owner-alias' } }))));
  assert.equal(s.replies.length, 20);
  assert.equal(s.state.userWindows["owner@c.us"].length, 10);
  assert.equal(s.state.userWindows['fake@c.us'].length, 10);
});

test('restarts preserve quotas and deduplication', async () => {
  const s = setup();
  for (let i = 0; i < 10; i++) await s.bot(s.message('saved' + i));
  const restarted = setup(JSON.parse(JSON.stringify(s.state)));
  await restarted.bot(restarted.message('saved0'));
  await restarted.bot(restarted.message('new'));
  assert.equal(restarted.replies.length, 0);
});

test('custom quotas appear in the footer and apply to every user', async () => {
  const s = setup(undefined, 2);
  await s.bot(s.message('one'));
  await s.bot(s.message('two'));
  await s.bot(s.message('three'));
  assert.equal(s.replies.length, 2);
  assert.match(s.replies[1].text, /2\/2/);
  assert.doesNotMatch(s.replies[1].text, /unlimited|exempt/i);
  await s.bot(s.message('other-one', 'owner@c.us'));
  await s.bot(s.message('other-two', 'owner@c.us'));
  await s.bot(s.message('other-three', 'owner@c.us'));
  assert.equal(s.replies.length, 4);
});

test('requests from different senders share bot-only history for 24 hours', async () => {
  const s = setup();
  await s.bot(s.message('first', 'student@c.us', { _data: { notifyName: 'Ana' } }));
  await s.bot(s.message('second', 'other@c.us', { _data: { notifyName: 'Luis' } }));
  assert.equal(s.state.groupHistory.length, 2);
  assert.equal(s.state.groupHistory[0].senderName, 'Ana');
  assert.equal(s.state.groupHistory[1].senderId, 'other@c.us');
  assert.equal(s.contexts[1].history[0].senderName, 'Ana');
  assert.equal(s.contexts[1].history[0].question, 'What assignments are there?');
});

test('shared history ranks relevant requests and ignores expired records', () => {
  const now = 1800000000000;
  const history = Array.from({ length: 8 }, (_, i) => ({ at: now - i * 1000, question: `general question ${i}`, answer: 'answer' }));
  history[0] = { at: now - 1000, senderName: 'Ana', question: 'physics energy assignment', answer: 'Calculate kinetic energy.' };
  history.push({ at: now - MEMORY_TTL_MS - 1, question: 'physics energy', answer: 'expired' });
  const found = relevantHistory(history, 'continue with the physics energy assignment', now);
  assert.ok(found.some(item => item.senderName === 'Ana'));
  assert.ok(found.every(item => item.answer !== 'expired'));
});
