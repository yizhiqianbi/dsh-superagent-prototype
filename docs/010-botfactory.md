# 010 BotFather

BotFather is a direct-message factory on the one WeCom smart-bot long connection. It grills a business line, writes an identity file, and wires that line onto the bot's chats and companion speech. It does not create a WeCom BotID. A second BotID is out of scope. Permissions are deferred: the identity file is not an allow list, and the existing WeCom userid list is left as it is.

The avatar stays the one bot. A business line is a persona, a chat policy, an optional Odoo hook, and a smoke greeting in plain speech.

## Where identities live

Under the superagent profile (`~/.dsh/profiles/superagent`, or `$DSH_HOME/profiles/<profile>`):

| Path | Role |
| --- | --- |
| `botfactory/botfather.yml` | The DM route. `route: dm`. `operators` empty means any direct message that shows factory intent. A non-empty list is only who may open the factory |
| `botfactory/identities/<id>.yml` | One business line |
| `botfactory/companions/<id>.md` | The speech the companion uses for that line |
| `botfactory/drafts/<userid>.json` | An unfinished grill |

The WeCom Source field `identitiesDir` points at `botfactory/identities`. `$DSH_SUPERAGENT_WECOM_IDENTITIES` is that directory, and empty when nothing is wired. The skill `skills/dsh-superagent-wecom/SKILL.md` tells an operator the same paths.

## Grill map

DM the bot `新建业务线` (or `/new`). BotFather asks, in order:

| What the operator settles | Identity field |
| --- | --- |
| What the line is called | `id` (template) and `name` |
| One-line persona | `persona` |
| Where it speaks: direct messages, named chats, or every connected group | `scope.directMessages`, `scope.groups`, `scope.otherChats` |
| What it answers immediately | `autoReply` |
| What it moves forward | `autoAdvance` |
| What needs a person to decide (需要你拍板) | `humanApprove` |
| Who phrases the options | `formatter` |
| Permissions | `permissions: deferred`. BotFather says this and does not ask for an allow list |
| Who to escalate to | `escalation` |
| ERP read/write and source of truth | `erp`. The only adapter is the existing Odoo Source on `crm.lead`. Field names in `write` must be the lead contact whitelist (`phone`, `email_from`, `contact_name`, `partner_name`, `function`, `description`) |
| Smoke greeting | `smoke` |

Reply `就这样` (or `可以` / `行` / `好`) to wire, or `取消` to drop the draft. A group message never enters the factory. The host posts the question; Eval ignores the turn and does not send a second message.

BotFather asks one block at a time, the way a colleague would, and a heard answer sticks. It does not ask the same sentence again. A miss gets a different sentence with short choices. Colloquial and slightly fuzzy wording is enough: 「他是我们的跟单同事」, 「群里都能说」, 「open」, 「所有群里面都行」, 「全员」. On a list, 「就这些」 and 「你写」 store the examples just offered, not the filler around them. 「它自己」 lets the line phrase the options. 「你写」 on the greeting drafts one sentence; on the persona it drafts a one-line role. A name is never invented.

A later sentence overrides an earlier slot instead of filling the current one. That covers ERP, where it speaks, and the persona. On the greeting step, 「不接入 Odoo」 or a workbench standing in for ERP turns ERP off and asks for the greeting again. The correction is not stored as the greeting. 「只私聊」 or 「改成只私聊」 updates the range and asks for the greeting again. 「人设改成…」 updates the persona and, on the confirm step, shows the recap again. Permissions stay `deferred`.

The confirm step is a short recap in a few lines: who it is, where it speaks, what it answers, what it moves forward, what needs a decision, who phrases the options, who to find, and whether Odoo is on. Placeholder scraps such as 「这些」, 「就这些」, and 「你以后要问的」 are not quoted back. 「不对」 asks which line to change.

Where it speaks has three answers. 「只私聊」 is direct messages only. A `wr_` or `oc_` id is a named group, with direct messages when the operator also says so. 「open」, 「所有群里面都行」, 「全员」, and the same kind of phrase mean direct messages plus every connected group. That is stored as `scope.directMessages: true` and `scope.otherChats: mentions` — the same `mentions` value a Source uses for other chats. It is not an allow list. BotFather still does not change the Source's other-chats switch, the Feishu CLI, or any credential.

`只私聊` is enough to activate a line on both channels. Wiring does not wait for a group @. WeCom still only pushes group messages that @ the bot. An `oc_` id is added to the Feishu chat list as mentions unless the line says `listen: all`. Direct messages stay on for both Sources, because that is where BotFather talks.

A WeCom chat id becomes a WeCom admission row. An `oc_` id becomes a Feishu admission row. The userid and open_id lists are untouched.

When one line owns the chat, a greeting uses that line's `smoke`. On Feishu the host sends that greeting and the factory questions, and stays quiet for other chat. Several lines sharing direct messages keep the shared greeting.

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
