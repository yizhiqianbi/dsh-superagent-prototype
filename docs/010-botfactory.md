# 010 BotFather

BotFather is a direct-message conversation on the one WeCom smart-bot long connection, and on the Feishu bot. The session thinks about a business line with the operator, asks what is still missing, and writes an identity file once the template is settled. It wires that line onto the bot's chats and companion speech. It does not create a WeCom BotID. A second BotID is out of scope. Permissions are deferred: the identity file is not an allow list, and the existing WeCom userid list is left as it is.

The avatar stays the one bot. A business line is a persona, a chat policy, an optional Odoo hook, and a smoke greeting in plain speech.

## Where identities live

Under the superagent profile (`~/.dsh/profiles/superagent`, or `$DSH_HOME/profiles/<profile>`):

| Path | Role |
| --- | --- |
| `botfactory/botfather.yml` | The DM route. `route: dm`. `operators` empty means any direct message that opens a business line. A non-empty list is only who may open that conversation |
| `botfactory/identities/<id>.yml` | One business line, the template |
| `botfactory/companions/<id>.md` | The speech the companion uses for that line |
| `botfactory/drafts/<userid>.json` | The open conversation. A Feishu draft is `feishu-<open_id>.json` |

The WeCom Source field `identitiesDir` points at `botfactory/identities`. `$DSH_SUPERAGENT_WECOM_IDENTITIES` is that directory, and empty when nothing is wired. The skill `skills/dsh-superagent-wecom/SKILL.md` tells an operator the same paths.

## Conversation

DM the bot `新建业务线` (or `/new`, `/botfather`). The host does not ask a form. The same session that handles other work talks: it follows the business, asks when something is missing, and lets a later answer replace an earlier one. When the line is clear, it says so in a few plain sentences and writes the template.

`取消`, `算了`, or `/cancel` drops an open conversation. A group message never enters it. Someone outside a non-empty `operators` list does not enter it either. A direct message with no identity directory still gets the short `--init` line from the host, and the session does not answer that turn a second time.

## Template

The file is the template. The session fills it. The host checks it and writes it, and does not invent the line's work to fill a gap.

| What the line records | Identity field |
| --- | --- |
| What the line is called | `id` (template; derived from `name` when omitted) and `name` |
| One-line persona | `persona` |
| Where it speaks: direct messages, named chats, or every connected group | `scope.directMessages`, `scope.groups`, `scope.otherChats` |
| What it answers immediately | `autoReply` |
| What it moves forward | `autoAdvance` |
| What needs a person to decide (需要你拍板) | `humanApprove` |
| Who phrases the options | `formatter` |
| Permissions | `permissions: deferred`. Always. The file is not an allow list |
| Who to escalate to | `escalation` |
| ERP read/write and source of truth | `erp`. The only adapter is the existing Odoo Source on `crm.lead`. Field names in `write` must be the lead contact whitelist (`phone`, `email_from`, `contact_name`, `partner_name`, `function`, `description`) |
| Smoke greeting | `smoke` |

Where it speaks is `scope`. A named group is a `wr_` id on WeCom or an `oc_` id on Feishu. Every connected group is `scope.directMessages` plus `scope.otherChats: mentions` — the same `mentions` value a Source uses for other chats. Recording it does not flip the Source switch, the Feishu CLI, or any credential.

Direct messages alone are enough to activate a line on both channels. Wiring does not wait for a group @. WeCom still only pushes group messages that @ the bot. An `oc_` id is added to the Feishu chat list as mentions unless the line says `listen: all`. Direct messages stay on for both Sources, because that is where BotFather talks.

A WeCom chat id becomes a WeCom admission row. An `oc_` id becomes a Feishu admission row. The userid and open_id lists are untouched. A group another line already owns is refused.

When one line owns the chat, a greeting uses that line's `smoke`. On Feishu the host sends that greeting and stays quiet for other chat. Several lines sharing direct messages keep the shared greeting. While a conversation is open, a later direct message stays in it instead of becoming that greeting.

## Both channels

The same identity file wires both bots. Chat ids other than `oc_` go to WeCom. `oc_` chat ids go to Feishu. `pnpm botfactory-wire` turns on `dsh-superagent-wecom` and `dsh-superagent-feishu`, sets `identitiesDir` on both Sources, and turns direct messages on. It does not change the Feishu CLI or the Feishu other-chats policy. A Feishu draft is stored apart from the WeCom draft. An operator id in `botfather.yml` may be a WeCom userid or a Feishu `ou_` open_id.

## Wire command

```sh
pnpm botfactory-wire --init
pnpm botfactory-wire --dry-run examples/botfactory/trade-followup.yml
pnpm botfactory-wire examples/botfactory/trade-followup.yml
```

`--init` writes `botfather.yml` if it is missing, turns on `dsh-superagent-wecom` and `dsh-superagent-feishu` in the profile `cordis.patch.yml`, and, when the panel on `127.0.0.1` answers, turns direct messages on and sets `identitiesDir` on both Sources. `--dry-run` validates and prints the smoke line. It does not write files. A real run copies `oc_` chats to Feishu and the other chats to WeCom when that panel answers. If the panel is down, the files are still written; run the command again once the panel is up so each Source stores the directory and its chats. The command never prints `WECOM_BOT_SECRET`.

Changing the plugin from disabled to enabled needs one restart. Chat and directory changes do not.

The example line is 外贸跟单伴侣 (`examples/botfactory/trade-followup.yml`).
