# Classroom WhatsApp Assistant


## Introduction

### Why this was made?

This deployment template was made for students who use Google Classroom. Originally made to be send in a WhatsApp group to give this information to my classmates. I hope this can serve to help you to automate it. Every document and guide that you need is inside this repo. I hope you like it 💖.

- By [zJuqni](https://zjuqni.com) [Comissions Open]

## What is this?

A configurable learning project that reads Google Classroom, summarizes new publications with Vertex AI, and sends notices and supported attachments to one WhatsApp group. Group members can mention the linked account to ask about publications, teachers, deadlines, or assignment explanations.

This repository is a **deployment template**. It contains no real account, school timetable, group, Cloud project, server address, or personal profile. Each installation supplies private settings. Defaults use UTC, English, a 15-minute interval, no subject mappings or timetable, and the same quota for every participant.

## Features

- Read-only access to active student courses: assignments, announcements, and materials.
- New-publication notices with original descriptions, summaries, key points, weekdays, deadlines, verified links, and supported Drive attachments.
- Approximate 24-hour and 12-hour reminders for deadlines recorded from new publications.
- Text-derived dates and optional next-class inference using your own weekly schedule.
- Mention replies searching every available publication page and filtering by course, teacher, official or description dates, or keywords (up to 25 results).
- Study explanations using supported attachment content when available.
- WhatsApp-native formatting, visible sender names when available, and a shared 24-hour memory of requests addressed to the bot.
- Persistent event tracking, serialized delivery, and a per-participant rolling request quota.

The assistant does not post in Classroom, submit assignments, modify files, or read grades/student submissions. Gmail is not used.

## Architecture

```text
Google Classroom + Google Drive
             | read-only access
             v
         Apps Script ----------> Vertex AI
             |                   summaries / study answers
             | HTTPS notices
             v
     Node.js bridge -----------> WhatsApp Web group
             |
             +-- mention queries --> Apps Script web app
```

| Location | Responsibility |
| --- | --- |
| `apps-script/TemplateConfig.gs` | Private configuration loading and validation. |
| `apps-script/Notificador.gs` | Polling, publication state, dates, timetable, attachments, reminders. |
| `apps-script/ClassroomBot.gs` | Protected, read-only mention queries and Vertex responses. |
| `apps-script/appsscript.json` | Runtime, advanced Classroom service, and OAuth scopes. |
| `whatsapp-bridge/src/` | HTTP bridge, WhatsApp session, event history, mention quota. |
| `whatsapp-bridge/deploy/` | Example systemd service and Nginx proxy. |
| `whatsapp-bridge/test/` | Offline tests with mocked Google and WhatsApp operations. |

## Requirements

- A Google account with access to the intended Classroom courses and Drive files. Institutional policies may block APIs or external web app access.
- A Google Cloud project with billing, Vertex AI enabled, and a supported model. The account running Apps Script needs permission to use Vertex in that project. The project may belong to another account if access is granted.
- Google Apps Script with the Classroom v1 advanced service and required API access.
- Node.js 22+, a server capable of running Chromium, private persistent storage, and an HTTPS endpoint. Ubuntu deployment examples are included.
- A WhatsApp account that can link to WhatsApp Web and participate in the selected group.

Vertex AI and hosting may cost money. Google Cloud budget alerts do **not** impose a hard spending cap. Configure quotas and billing controls for your own account.

## 1. Configure Apps Script

1. Create a new Apps Script project and add **all three** `.gs` files from `apps-script/`.
2. In Project Settings, show `appsscript.json` and replace it with the supplied manifest. Enable the Classroom v1 advanced service. Review the requested scopes before authorizing.
3. Enable Vertex AI in your Cloud project and grant the executing Google account the required access. Select a model ID and location available to that project; the template deliberately does not choose a model.
4. In **Project Settings → Script Properties**, add the settings below. `script-properties.example.json` is a reference, not an automatic import. All values, including JSON arrays/objects, are strings.

### Required private settings

| Property | Value |
| --- | --- |
| `VERTEX_PROJECT_ID` | Your Google Cloud project ID. |
| `VERTEX_MODEL` | Your chosen Vertex model ID. |
| `WA_BRIDGE_URL` | HTTPS bridge base URL, without `/notify`. |
| `WA_BRIDGE_TOKEN` | Private random secret of at least 32 characters; identical to bridge `BRIDGE_TOKEN`. |
| `WA_BOT_GROUP_ID` | Exact authorized group ID; identical to bridge `WA_GROUP_ID`. |
| `WA_BRIDGE_ENABLED` | `false` while configuring; `true` enables notice delivery. |

### Optional settings

| Property | Default | Meaning |
| --- | --- | --- |
| `APP_TIMEZONE` | `Etc/UTC` | IANA timezone for notices, local dates, and timetable inference. Set the manifest timezone consistently too. |
| `RESPONSE_LANGUAGE` | `English` | Language requested for AI-generated summaries/answers. Fixed labels and operational errors remain English. Original Classroom text remains in its source language. |
| `VERTEX_LOCATION` | `global` | Location supporting the chosen model; used in the API resource path. |
| `POLL_INTERVAL_MINUTES` | `15` | Allowed: `1`, `5`, `10`, `15`, `30`. Re-run the installer after changing it to replace the trigger. |
| `DATE_ONLY_DUE_TIME` | `23:59` | Local `HH:mm` assumption for dates without a time, displayed as an assumption. |
| `CLASSROOM_COURSE_IDS_JSON` | `[]` | Course ID allowlist. Empty means all active courses accessible as a student. |
| `SUBJECT_ALIASES_JSON` | `{}` | Canonical subject names mapped to arrays of course-name aliases. |
| `WEEKLY_SCHEDULE_JSON` | `{}` | Subjects mapped to weekday numbers and period ID arrays. Monday=`1`, Sunday=`7`. |
| `CLASS_PERIOD_TIMES_JSON` | `{}` | Period IDs mapped to local `HH:mm` start times. |

Leave all three timetable settings empty if you only need official/text deadlines. No default curriculum or timetable is inferred. Aliases match case-insensitive, accent-insensitive substrings in course names; ambiguous matches disable subject inference.

**Fictitious example:** independent JSON strings for Script Properties, not a real timetable.

```json
{
  "SUBJECT_ALIASES_JSON": "{\"Example Subject\":[\"sample course\"]}",
  "WEEKLY_SCHEDULE_JSON": "{\"Example Subject\":{\"1\":[\"sessionA\"],\"5\":[\"sessionB\"]}}",
  "CLASS_PERIOD_TIMES_JSON": "{\"sessionA\":\"08:30\",\"sessionB\":\"11:15\"}"
}
```

5. Once the bridge and group settings are ready, run `validateTemplateConfiguration()`. It validates settings without reading Classroom, calling Vertex, or sending messages. Replace all placeholders first.
6. Deploy an Apps Script **web app** executing as the account with Classroom access. Choose an access setting that lets the server reach its `/exec` URL. Every application request requires the secret and authorized group ID. The web app uses the executing account's permissions; protect the secret and review this access. Institutional policies may prevent external deployment.
7. Set that `/exec` URL as bridge `CLASSROOM_BOT_URL`. After editing source, update the web app deployment version for mention replies to use the changes.
8. When ready, set `WA_BRIDGE_ENABLED=true` and run `instalarNotificador()` once. It records existing publications as history and creates the trigger. It does **not** replay old posts or send a test notice. Existing posts are not enrolled for reminders automatically.

`pausarNotificador()` disables the scheduled notifier. Review state with `verEstadoNotificador()`. Mention replies are independent: remove bridge `CLASSROOM_BOT_URL` and restart the service to disable them.

The manifest requests read-only Classroom/Drive access, read-only teacher roster access, external requests, trigger management, and Cloud API access for Vertex. Review scopes and narrow them if removing features.

## 2. Configure the WhatsApp bridge

Follow the [bridge setup guide](whatsapp-bridge/README.md): install dependencies, configure a private environment file, link WhatsApp, select a group using the authenticated `/groups` endpoint, and configure HTTPS/persistent service operation.

Every participant has the same `WA_MESSAGES_PER_HOUR` quota (default `10`), including the owner. It counts admitted requests in a rolling hour, including failed queries. A long answer may become multiple WhatsApp messages. Replies show usage; excess requests are ignored until capacity returns. No display name or account bypasses the limit.

### Mention memory

The bridge keeps one shared history for the configured group. It stores only direct requests to the bot and the replies it sends, with timestamp, sender ID, and visible display name when WhatsApp provides one. Entries expire after 24 hours. Ordinary group messages and attachment bytes are not stored. For a new query, the bridge supplies recent turns and older turns that appear relevant, within a bounded context size. This memory is shared by the whole group, not separated by participant.

## Dates, files, and delivery

- Classroom's structured due date/time is UTC and is converted to `APP_TIMEZONE`. Text dates use timezone-aware local parsing, not a fixed offset. See the [Classroom reference](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork) and [Apps Script date utilities](https://developers.google.com/apps-script/reference/utilities/utilities).
- Official deadlines take precedence. Text-derived dates require a supporting quote but still depend on model interpretation. Missing times use the configured, labeled assumption.
- Next-class inference uses publication time and the configured weekly schedule. Without a timetable, no class date is invented. Holidays, closures, and exceptional changes are not represented.
- Notices support **10 files**, **10 MiB per file**, and **20 MiB total**. Native Google files are exported to PDF where supported. Oversized, inaccessible, or unsupported exports retain links and show a warning.
- Study queries read at most **3 files**, **4 MiB per file**, and **8 MiB total**. Supported inputs: PDF, PNG/JPEG/WebP, plain text, DOCX text extraction, and supported Google PDF exports. DOCX text extraction omits images and may lose layout. The model cannot claim to read content that was not supplied.
- Reminders run after the 24/12-hour thresholds while the deadline remains future. They are approximate; downtime may skip a threshold. Edits are not new publications and do not update saved reminder deadlines.
- Event IDs and saved progress suppress ordinary duplicate retries. Delivery is not guaranteed exactly once: crashes/uncertain network results can duplicate sends. Mention handling favors avoiding replay and can lose a reply interrupted during sending.

## Privacy

Store deployment values only in Script Properties and a private environment file. Never commit tokens, keys, real settings, WhatsApp sessions/QRs, runtime history, private screenshots, classmates' data, or Classroom attachments.

`.gitignore` excludes common credentials/session files plus `apps-script/script-properties.json` and `*.local.json`. It cannot detect secrets pasted into normal source: review changes before pushing.

Descriptions, questions, selected attachment contents, and the relevant bot-request history go to your configured Vertex project. The bridge saves event IDs, mention IDs, quota identifiers, the shared bot-request history (24-hour expiry), and WhatsApp authentication state in its private data directory. Protect logs, group lookup results, and backups. Forward course content only to recipients allowed to access it.

## WhatsApp limitations

The bridge automates WhatsApp Web with `whatsapp-web.js`. It is not the official WhatsApp Business Platform API. Session disconnections, account restrictions, and breakage after WhatsApp changes are possible. The pinned dependency has a version-specific media compatibility patch described in the bridge guide. This template does not guarantee account safety or long-term compatibility.

## Local verification

```sh
cd whatsapp-bridge
node --test
```

Tests require Node.js only and do not connect to Classroom, Vertex, or WhatsApp. They cover mention admission/deduplication, uniform quotas, authorization rejection, teacher filtering, configuration validation, local dates, half-hour timezones, DST timetable inference, installer behavior, and reminder state. Google utilities are mocked with explicit fixtures; these checks do not replace authorized integration checks on a new deployment.

Documentation, comments, prompts, logs, and fixed labels are in English. Existing source identifiers/internal enum values (`Tarea`, `Anuncio`, `EXACTA`, etc.) remain stable for compatibility; they are not installation-specific subject names.

## Status

A learning/portfolio template for one authorized Classroom account and one group. It is not a hosted service, multi-tenant product, or guaranteed delivery system. Validate configuration, review permissions, and use an environment you control before enabling notices.
