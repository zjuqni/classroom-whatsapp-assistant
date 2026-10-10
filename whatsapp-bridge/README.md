# WhatsApp bridge setup

Receives notices from Apps Script and forwards them to one WhatsApp group. Direct mentions call the protected Apps Script web app. See the root [README](../README.md) for Google configuration and limitations.

## Install and configure

Use Node.js 22+ and a host with Chromium/Puppeteer's operating-system libraries. Run as a dedicated non-root user; keep Chromium's sandbox enabled.

```sh
npm ci
cp .env.example .env
chmod 600 .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Privately copy the generated value into `.env` as `BRIDGE_TOKEN` and Apps Script as `WA_BRIDGE_TOKEN`. Never put it in source, screenshots, or shared logs.

| Setting | Purpose |
| --- | --- |
| `PORT` / `HOST` | Local listen address: default `3018` / `127.0.0.1`. |
| `DATA_DIR` | Private persistent directory; example `./data`, relative to working directory. |
| `BRIDGE_TOKEN` | Required secret of at least 32 characters. |
| `WA_GROUP_ID` | Single destination group; can be empty during initial linking. |
| `CLASSROOM_BOT_URL` | Apps Script `/exec` URL; empty disables mention replies. |
| `WA_MESSAGES_PER_HOUR` | Positive integer, default `10`, applied equally to everyone. |
| `MAX_BODY_BYTES` | Optional HTTP body limit; default `35000000` bytes. |

`npm start` expects an externally supplied environment. To load local `.env` explicitly:

```sh
node --env-file=.env src/server.js
```

Do not run two instances against the same state/session directory.

## Link and select a group

Initially leave `WA_GROUP_ID` and `CLASSROOM_BOT_URL` empty. Scan the QR using WhatsApp → Linked devices. It appears in private console output and `DATA_DIR/whatsapp-qr.svg`. Protect both like credentials and delete obsolete QR images after linking.

Authenticated `GET /groups` lists group names/IDs without sending messages. For example, this loads the local secret rather than putting it in a command argument:

```sh
node --env-file=.env -e "fetch('http://127.0.0.1:3018/groups',{headers:{Authorization:'Bearer '+process.env.BRIDGE_TOKEN}}).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);console.log(await r.json())})"
```

Adjust the address if needed. Keep output private. Set `WA_GROUP_ID`, copy the same value into Apps Script `WA_BOT_GROUP_ID`, set `CLASSROOM_BOT_URL`, and restart. Linking/group selection does not require a test message.

## Pinned media compatibility patch

`whatsapp-web.js` is pinned to `1.34.7`. The patch removes a private media ID before it can overwrite an outgoing message ID:

```sh
node apply-media-hotfix.cjs
```

Apply after `npm ci` for this pinned integration. Reinstalling dependencies removes the patch, so reapply it. It is idempotent and rejects an unexpected insertion point. Reassess when upgrading: this is a dependency workaround, not a permanent upstream fix, and WhatsApp can change independently.

## Ubuntu service and HTTPS

The deployment files are examples, not automatically installed:

1. Create dedicated account `classroom-wa`, install under `/opt/classroom-wa-bridge`, and give that account ownership of `/var/lib/classroom-wa-bridge`.
2. Store private settings in `/etc/classroom-wa-bridge.env` with restrictive permissions. Set `DATA_DIR=/var/lib/classroom-wa-bridge` to match the service's writable directory.
3. Adapt `deploy/classroom-wa-bridge.service` to your Node binary, account, and paths. Install as a systemd unit, then enable/start it. It loads the environment file directly.
4. Replace `YOUR_DOMAIN_OR_IP` in the Nginx example. Add a valid TLS certificate/HTTPS listener and redirect HTTP to HTTPS; the example is only an HTTP proxy starting point.
5. Keep Node bound to loopback. Expose the HTTPS proxy, not port 3018. Set Apps Script `WA_BRIDGE_URL` to its HTTPS base URL.

Keep session state across restarts and protect backups like login credentials. Service logs can contain a linking QR. Health/group lookup are read-only; notifier/mention delivery sends messages.

## Endpoints

| Endpoint | Authentication | Behavior |
| --- | --- | --- |
| `GET /health` | None | Connection/configuration flags, no secret values. |
| `GET /groups` | `Authorization: Bearer <BRIDGE_TOKEN>` | Read group names and IDs. |
| `POST /notify` | Same header | Deliver to the configured group. **Sends messages.** |

Notifications accept `eventId`, `text`, and optional `attachments` (`filename`, `mimeType`, `base64`). Stable event IDs suppress ordinary retries. Progress and quotas persist in `sent-events.json`; deleting state also removes deduplication history. Up to 10,000 completed event IDs and handled mention IDs are retained.

## Offline verification

```sh
node --test
```

Mocks are used: tests do not authenticate or send WhatsApp messages.
