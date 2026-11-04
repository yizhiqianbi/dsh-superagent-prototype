# 010 BotFather

BotFather is a direct-message conversation on a WeCom bot the operator already runs, and the same conversation can run on Feishu. The session thinks about a business, asks what is still missing, and writes a **role package** once the template is settled. 分马甲、自建 BotID、只管 role: each WeCom business is its own 智能机器人. The operator creates that BotID. BotFather does not ask for it, does not write it, and does not create the bot through an API.

The role is not another mask on the bot that held the conversation. Settling it does not copy the role's chats onto that connection, and it does not change that bot's greeting. Permissions are deferred: the identity file is not an allow list, and the existing WeCom userid list is left as it is.

A role is a persona, a chat policy, an optional Odoo hook, a smoke greeting in plain speech, and a hang note.

## Where identities live

Under the superagent profile (`~/.dsh/profiles/superagent`, or `$DSH_HOME/profiles/<profile>`):

| Path | Role |
| --- | --- |
| `botfactory/botfather.yml` | The DM route. `route: dm`. `operators` empty means any direct message that opens a business line. A non-empty list is only who may open that conversation |
| `botfactory/identities/<id>.yml` | The role: persona, SOP, scope, templates |
| `botfactory/companions/<id>.md` | How that role speaks, for the bot the operator hangs |
| `botfactory/roles/<id>.md` | The hang note: what was written, and how to point a new 智能机器人 at it |
| `botfactory/drafts/<userid>.json` | The open conversation. A Feishu draft is `feishu-<open_id>.json` |

The WeCom Source field `identitiesDir` points at `botfactory/identities` so the grill can read and write that package. `$DSH_SUPERAGENT_WECOM_IDENTITIES` is that directory, and empty when no package has been written. It is not a second BotID, and chats named in a role are not added to this connection. The skill `skills/dsh-superagent-wecom/SKILL.md` tells an operator the same paths.

## Conversation

DM the bot `新建业务线` (or `/new`, `/botfather`). The host does not ask a form. The same session that handles other work talks: it follows the business, asks when something is missing, and lets a later answer replace an earlier one. When the line is clear, it says so in a few plain sentences and writes the template.

A picture in that direct message is downloaded and shown to the session with the words, so it can read a screenshot. The caption and a quote stay with the picture. The download address and its key are not shown to the session.

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

The scope is what the operator copies onto the new bot. It does not become an admission row on the bot that wrote the role. The userid and open_id lists are untouched. A group another role already owns is refused.

The factory bot keeps its own greeting. On Feishu the host stays quiet except for the factory conversation. While a conversation is open, a later direct message stays in it.

## After it settles

The host says, in Chinese, which files it wrote and how to hang them: create a new 智能机器人 in the WeCom admin console, choose the long connection, put that bot's BotID and Secret in its own env or profile (`WECOM_BOT_ID`, `WECOM_BOT_SECRET`), and point that profile at this role. The conversation does not ask for those values. The longer steps are in `botfactory/roles/<id>.md`.

## Both channels

Chat ids other than `oc_` are WeCom chats for the new bot. `oc_` chat ids are Feishu chats recorded on the same role. `pnpm botfactory-wire` turns on `dsh-superagent-wecom` and `dsh-superagent-feishu`, sets `identitiesDir` on both Sources, and turns direct messages on so the grill can run. It does not copy the role's chats onto either Source. It does not change the Feishu CLI or the Feishu other-chats policy. A Feishu draft is stored apart from the WeCom draft. An operator id in `botfather.yml` may be a WeCom userid or a Feishu `ou_` open_id.

## Wire command

```sh
pnpm botfactory-wire --init
pnpm botfactory-wire --dry-run examples/botfactory/trade-followup.yml
pnpm botfactory-wire examples/botfactory/trade-followup.yml
```

`--init` writes `botfather.yml` if it is missing, turns on `dsh-superagent-wecom` and `dsh-superagent-feishu` in the profile `cordis.patch.yml`, and, when the panel on `127.0.0.1` answers, turns direct messages on and sets `identitiesDir` on both Sources. That is the grill, not a new mask. `--dry-run` validates and prints the smoke line and the hang steps. It does not write files. A real run writes the role package. If the panel is down, the files are still written; run the command again once the panel is up so each Source stores the directory. The command names `WECOM_BOT_SECRET` as the variable the operator fills. It never prints that variable's value.

Changing the plugin from disabled to enabled needs one restart. Chat and directory changes do not.

The example line is 外贸跟单伴侣 (`examples/botfactory/trade-followup.yml`).
