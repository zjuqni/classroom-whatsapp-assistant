'use strict';

function formatWhatsAppText(input) {
  let text = String(input || '').replace(/\r\n?/g, '\n');
  text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, _language, code) => `\n\`\`\`${code.trim()}\`\`\`\n`);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2');
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*');
  text = text.replace(/\*\*(.+?)\*\*/gs, '*$1*').replace(/__(.+?)__/gs, '*$1*');
  text = text.replace(/`([^`\n]+)`/g, '```$1```');
  text = text.replace(/^[ \t]*[-+*][ \t]+/gm, '• ');
  text = text.replace(/^[ \t]*(\d+)\.[ \t]+/gm, '$1) ');
  text = text.replace(/^[ \t]*>[ \t]?/gm, '┃ ');
  text = text.replace(/^[ \t]*(?:---+|___+|\*\s*\*\s*\*+)[ \t]*$/gm, '');
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*(?:\r?\n|$)/gm, '');
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_line, row) => `• ${row.split('|').map(cell => cell.trim()).filter(Boolean).join(' · ')}`);
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function splitWhatsAppText(input, maxLength = 3000) {
  const text = formatWhatsAppText(input);
  const chunks = [];
  let current = '';
  for (const paragraph of text.split(/\n\n+/)) {
    if (paragraph.length > maxLength) {
      if (current) { chunks.push(current); current = ''; }
      const words = paragraph.split(/\s+/);
      let part = '';
      for (const word of words) {
        if (word.length > maxLength) {
          if (part) { chunks.push(part); part = ''; }
          for (let offset = 0; offset < word.length; offset += maxLength) chunks.push(word.slice(offset, offset + maxLength));
          continue;
        }
        const next = part ? `${part} ${word}` : word;
        if (next.length > maxLength && part) { chunks.push(part); part = word; }
        else part = next;
      }
      if (part) chunks.push(part);
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength && current) { chunks.push(current); current = paragraph; }
    else current = candidate;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks;
}

module.exports = { formatWhatsAppText, splitWhatsAppText };
