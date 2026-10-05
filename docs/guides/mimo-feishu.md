# MiMo and Feishu in the TubeLiu fork

[简体中文](mimo-feishu.zh.md) | English

This fork extends the complete upstream Qwen Audio Agent desktop application.
Its floating orb, conversation panel, tasks, memory, knowledge, MCP, backend
Agent choices and existing voice providers retain their original implementation.
MiMo is another native frontend provider; Feishu is an additional tool source,
not a replacement for the selected backend Agent.

## Desktop setup

Open **Settings → Voice Frontend → MiMo** and configure chat, recognition and
speech separately:

| Service | Default model | Default URL |
| --- | --- | --- |
| Chat | `mimo-v2.6-flash` | `https://token-plan-cn.xiaomimimo.com/v1` |
| Recognition | `mimo-v2.5-asr` | `https://token-plan-cn.xiaomimimo.com/v1` |
| Speech | `mimo-v2.5-tts` | `https://token-plan-cn.xiaomimimo.com/v1` |

Speech defaults to voice `mimo_default`. Each service has its own key and URL;
configured addresses are preserved, with no automatic rerouting. Save the form
to restart the embedded Gateway with those settings.

MiMo currently uses local voice activity detection followed by ASR, chat and
streaming TTS. It supports microphone mute, interruption and result speech.
It does not expose image/video input or claim end-to-end duplex model support.
The upstream providers continue to expose their own supported capabilities.

Open **Settings → Feishu → Connect Feishu**. Existing verified authorization
from the official local CLI is reused. Otherwise, the application opens the
Feishu authorization page; finish there and click **Authorization complete**.
Desktop builds include the official native CLI for their platform. Credentials
remain in the CLI's local credential store and are never bundled into an installer.

## Feishu work

Ask to read/search a document, find a chat, send a message, list/create/update/
delete a calendar event, create a Base/table/task record, or list/create/complete
a task. Read operations run directly; incomplete requests ask for clarification.
Feishu tasks use the existing task list, progress, cancellation and result speech.

Writes open a full preview in the conversation panel. Review the contents,
check the review box, and click the button for that operation. Each approval
is consumed once and expires after five minutes. Spoken permission, `always`
and generic Agent permission buttons cannot approve an integrated Feishu write.
This approval policy applies to the added Feishu tool source. Other configured
backend Agents retain their own tools and permission policies.

Feishu planning uses the configured MiMo chat service. Advanced users can set
`FEISHU_BASE_URL`, `FEISHU_API_KEY` and `FEISHU_CHAT_MODEL` in `config.env` to use
a separate OpenAI-compatible planner. A different host needs its own key.
Set `FEISHU_ENABLED=false` to disable this tool source. `FEISHU_CLI_PATH` can
select an explicitly installed native CLI.

## Development and builds

```sh
npm ci
node scripts/prepare-feishu-cli.mjs
npm run build
npm run desktop
npm run desktop:build:win       # Windows x64 NSIS installer
npm run desktop:build:local     # unsigned local macOS DMG, run on macOS
```

The packaging hook downloads version `1.0.97` of the official Feishu CLI,
verifies its pinned SHA-256, and places the native executable outside ASAR.
Mac universal builds include both native CLI architectures. Preserve the
upstream signed build command when distributing a signed, notarized macOS app.

This fork has a distinct application ID, `qwaudio-tubeliu` pairing scheme,
update repository and default configuration directory:
`~/.config/qwaudio-tubeliu` (or `$XDG_CONFIG_HOME/qwaudio-tubeliu`). Explicit
`QWAUDIO_CONFIG_DIR` and the upstream runtime path overrides remain supported.
It can coexist with the official desktop application.

To import API settings from the earlier local Feishu assistant:

```sh
node scripts/import-feishu-assistant-config.mjs --source /path/to/previous/.env
```

The importer copies the configured service addresses and independent keys into
private native settings. It keeps the original file, refuses to overwrite an
existing MiMo profile, and uses local Gateway port 18900 to coexist with the
earlier service. It does not import conversation data or package credentials.

Run `npm run lint`, `npm test`, `npm run build`, `npm run release:check` and
`npm run test:desktop-package` before distribution. macOS packages require a
macOS runner; Windows verification is not macOS device verification.
