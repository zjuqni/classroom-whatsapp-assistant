const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.dirname(require.resolve('whatsapp-web.js'));
const candidates = [
  path.join(packageRoot, 'src', 'util', 'Injected', 'Utils.js'),
  path.join(packageRoot, 'util', 'Injected', 'Utils.js'),
];
const injectedUtils = candidates.find(candidate => fs.existsSync(candidate));
if (!injectedUtils) throw new Error('Could not find whatsapp-web.js Injected/Utils.js');
const source = fs.readFileSync(injectedUtils, 'utf8');

if (source.includes('delete message.__x_id;')) {
  console.log('WhatsApp media hotfix is already applied.');
  process.exit(0);
}

const marker = "        // Bot's won't reply if canonicalUrl is set (linking)";
if (!source.includes(marker)) {
  throw new Error(`Could not find the expected insertion point in ${injectedUtils}`);
}

const replacement = [
  '        // MediaData has a private __x_id that can overwrite the outgoing',
  "        // message ID when spread above. This breaks WhatsApp's sender getter.",
  '        delete message.__x_id;',
  '',
  marker,
].join('\n');
fs.writeFileSync(injectedUtils, source.replace(marker, replacement));
console.log(`Applied WhatsApp media hotfix to ${injectedUtils}`);
