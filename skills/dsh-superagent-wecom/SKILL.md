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
- Each recorded text or card click also queues one short notice on that same chat, even when Eval ignores it and opens no ticket. A greeting is 「在的。跟单、催办、到账确认这类事直接说就行。」 Other chat is 「收到。具体要办的事（客户/订单/节点）说一下，我帮你盯着推进；需要你拍板的我会先把选项列好。」 A wired business line replaces the greeting with that line's smoke sentence. The same msgid does not send it twice, and an acknowledgement already queued for that trigger is left alone. A card with no title line is titled 待确认.
- An image, a file, or a video alone is not a Trigger. There is no history API, so an assessment sees the triggering message and nothing before it.
- Outbound text goes out as markdown on `aibot_send_msg`. A short report whose body fits a card and which has at least two lines such as `① 合并` and `② 再看` goes out as a button card. The click comes back as that line.
- The boss has to message the bot once before a proactive report can reach that chat. A lost acknowledgement can deliver the same report twice: WeCom does not accept this host's message id as an idempotency key.
- `$DSH_SUPERAGENT_WECOM_BOT` is the BotID. `$DSH_SUPERAGENT_WECOM_CHAT` is the chat that started the ticket, and is empty for a ticket that started somewhere else. `$DSH_SUPERAGENT_WECOM_IDENTITIES` is the directory of business lines BotFather wrote, and is empty when none are wired. Companion fragments for those lines are in `companions/` next to that directory.

## BotFather

BotFather is a direct-message factory on this same bot. It is not a second BotID, and it does not grant permissions. Multi-BotID is out of scope.

Identities live under the superagent profile: `botfactory/botfather.yml` is the DM route (an empty `operators` list means any direct message that shows factory intent), `botfactory/identities/<id>.yml` is one business line, and `botfactory/companions/<id>.md` is the speech the companion uses. The Source field `identitiesDir` points at `botfactory/identities`. The same directory is also unioned into the WeCom chat list and the admission rows, so a line is active without a group @. WeCom still only pushes group messages that @ the bot. Direct messages have to stay on, because that is where BotFather talks.

Run `pnpm botfactory-wire --init` once so the profile listens, then DM the bot 「新建业务线」. Or validate a finished file with `pnpm botfactory-wire --dry-run examples/botfactory/trade-followup.yml` and wire it with the same command without `--dry-run`. The command does not print `WECOM_BOT_SECRET`. See [docs/010-botfactory.md](../../docs/010-botfactory.md).

## Live check

From an allowed userid, mention the bot in a listed group or message it directly. A Trigger appears. This repository's tests do not open a socket and do not contain a BotID or a Secret.
