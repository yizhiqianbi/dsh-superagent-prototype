---
name: dsh-superagent-odoo
description: Chase an assigned Odoo lead, manufacturing order or sales order, and open Attention when progress slips.
---

Use this skill only when the ticket started on Odoo. `$DSH_SUPERAGENT_ODOO_MODEL`, `$DSH_SUPERAGENT_ODOO_RES_ID` and `$DSH_SUPERAGENT_ODOO_ACTIVITY` name the record and the activity. When those variables are empty, this ticket is not an Odoo ticket: do not call the Odoo tools.

Acknowledge the activity with `orchestrator_ack` before the chase. The acknowledgement names the record and that you are checking progress or filling the stated contact. It must not promise a new date, an expedite, a customer date, a QC release or a payment. Finish with `orchestrator_report`.

Do not call XML-RPC yourself. Do not open another model or another record. Do not change stage, owner, revenue, dates, quantities, QC or payment, and do not send a customer email.

## CRM lead (`crm.lead`)

The three tools touch only that lead:

- `odoo_search_read` reads the whitelisted fields. Pass `model` `crm.lead`.
- `odoo_write` writes only `phone`, `email_from`, `contact_name`, `partner_name`, `function` and `description`. `partner_name` is the company and `contact_name` is the person. Copy a value only when the activity text states it. Never invent a phone, email or name.
- `odoo_message_post` posts one short internal note: which fields were filled, and which stayed empty.

## Production progress (`mrp.production` or `sale.order`)

This is SOP step 5. Read the snapshot, post one internal chase note when the order is on track, and open Attention when a person must decide. There is no `odoo_write` on these tickets.

Call `odoo_search_read` with `model` set to `$DSH_SUPERAGENT_ODOO_MODEL` and without `fields`, so the declared snapshot is what gets classified. The tool skips fields this Odoo does not have. `progress.signal` is the chase. Do not reclassify it yourself.

When `unavailable` is true, post nothing and report `progress` with a summary that names the reason. Do not invent a state, a date or a quantity.

When `progress.signal` is `on_track`:

- `odoo_message_post` one internal note: the order name, its state, and the planned date when the snapshot has one. Say that the chase found nothing to escalate.
- `orchestrator_report` `ready` when state is `done` or `cancel`, otherwise `progress`. Do not set `human_action`.

When `progress.signal` is `overdue`, `stale` or `shortfall`:

- Do not `odoo_message_post`. The Attention delivery is the internal note.
- `orchestrator_report` with `state` `progress` and `human_action` set to `progress.attention`, copied exactly. That string is the ticket's Attention. The panel already shows it as 待人工决定 / Attention and renders the Markdown. It has three options (继续催, 建议改期给人确认, 升级缺料异常), one recommendation, and the risk.
- Do not report state `waiting`. `waiting` means the executor finished a turn and is idle. It is not a human gate, and this tool does not accept it.
- Do not replace the question with "please advise" or drop an option. A date change, an expedite, a customer promise, a QC release and a payment stay with the person who answers.
