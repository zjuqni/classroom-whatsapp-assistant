'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatWhatsAppText, splitWhatsAppText } = require('../src/whatsapp-format');

test('converts Markdown-like model output to WhatsApp formatting with clear paragraphs', () => {
  const result = formatWhatsAppText('# Assignment\n\n**Due:** Tuesday\n\n- Solve exercises\n- [Open Classroom](https://classroom.google.com/example)');
  assert.equal(result, '*Assignment*\n\n*Due:* Tuesday\n\n• Solve exercises\n• Open Classroom: https://classroom.google.com/example');
  assert.doesNotMatch(result, /(^#|\*\*|\[[^\]]+\]\()/m);
});

test('flattens Markdown tables without retaining separator rows', () => {
  const result = formatWhatsAppText('| Course | Deadline |\n| --- | --- |\n| Physics | Friday |');
  assert.equal(result, '• Course · Deadline\n• Physics · Friday');
  assert.doesNotMatch(result, /---/);
});

test('splits long responses at word boundaries within the WhatsApp message limit', () => {
  const chunks = splitWhatsAppText('**Step 1**\n\n' + 'word '.repeat(130), 300);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 300));
  assert.ok(splitWhatsAppText('x'.repeat(601), 300).every(chunk => chunk.length <= 300));
});
