---
name: dsh-superagent-wecom
description: Set up the WeCom smart-bot long connection for gate reports. The Secret stays in the environment.
---

Use this when enabling the WeCom Source. The host already delivers replies on that chat. Do not call the WeCom API yourself, and do not put the Secret in settings, a prompt, or a commit.

## Operator setup

1. In the WeCom admin console, create a 智能机器人. Open API mode and choose「长连接」. Copy the BotID and the long-connection Secret. That Secret is not the callback Token or EncodingAESKey.
2. Export the Secret as `WECOM_BOT_SECRET` in the environment of the `superagent` profile. Export the BotID as `WECOM_BOT_ID`, or type it into the Source's BotID field. The Source field `secretEnv` names the variable (default `WECOM_BOT_SECRET`).
3. In the profile's `cordis.patch.yml`, set `id: dsh-superagent-wecom` and `disabled: false`. Restart dsh-superagent.
4. In Sources, turn 企业微信 on. Add the group chat ids that should receive @ mentions. Direct messages default to on. Under Eval, on this Source, list the userids who may originate work.
5. Confirm health `wecom` becomes ready. It stays in error until both the BotID and the Secret are present. One process may keep one connection per BotID; a second subscription disconnects the first.

## What the connection can do

- Inbound text, a voice transcript, mixed text, and a template-card button click become Triggers. A group message is a mention. A direct message is direct. The long connection does not deliver other group messages.
- An image, a file, or a video alone is not a Trigger. There is no history API, so an assessment sees the triggering message and nothing before it.
- Outbound text goes out as markdown on `aibot_send_msg`. A short report whose body fits a card and which has at least two lines such as `① 合并` and `② 再看` goes out as a button card. The click comes back as that line.
- The boss has to message the bot once before a proactive report can reach that chat. A lost acknowledgement can deliver the same report twice: WeCom does not accept this host's message id as an idempotency key.
- `$DSH_SUPERAGENT_WECOM_BOT` is the BotID. `$DSH_SUPERAGENT_WECOM_CHAT` is the chat that started the ticket, and is empty for a ticket that started somewhere else.

## Live check

From an allowed userid, mention the bot in a listed group or message it directly. A Trigger appears. This repository's tests do not open a socket and do not contain a BotID or a Secret.
