# 011 SOP production progress

SOP step 5 of the export-order companion: chase production progress, and raise an exception when a person must decide. It extends the Odoo Source in [009 Odoo](009-odoo.md). It does not add a Source, a domain concept, or a write that the [010 ERP adapter](010-erp-adapter.md) leaves with a person.

The worker procedure is the Odoo skill, `skills/dsh-superagent-odoo/SKILL.md`. The orchestrator prompt accepts the activity as production-progress work.

## Trigger

The poll is still `mail.activity` assigned to the agent's Odoo user, newer than the cursor. `activityDomain` allows `res_model` `crm.lead`, `mrp.production` or `sale.order`. The Trigger id is still the activity id (`key('odoo', 'activity', id)`), so an edit of the same activity does not open another Ticket. The agent's own activity is still dropped.

The Thread id is the related record: `mrp.production:<id>`, `sale.order:<id>` or `crm.lead:<id>`. The Channel address is `{ model, res_id }` for that same record.

A database without `mrp.production` or `sale.order` is not an error. After a successful poll, `fields_get` probes those two models. A missing-model fault is a health note (`mrp.production not installed; crm.lead activities still poll`). Any other probe fault is ignored on that note, because the activity read already succeeded. The poller does not throw, and CRM activities still open Tickets. The domain still names the optional models: a missing model simply has no rows.

## What the agent does

On a manufacturing or sales Ticket the worker has two tools. There is no field write.

`odoo_search_read` reads that Ticket's record. It calls `fields_get` and requests only the declared fields that exist, so a renamed or absent field does not fail the read. The result lists `fields`, `skipped`, the record, and `progress`.

`odoo_message_post` posts one internal note (`message_type` `comment`, `subtype_xmlid` `mail.mt_note`). That is the chase. It is not a customer email. The Channel uses the same note for an acknowledgement and for an Attention delivery, and it still deduplicates by the outbound message id.

The worker then calls `orchestrator_report`.

When `progress.signal` is `on_track` (state `done` or `cancel`, or the planned date is still ahead and `write_date` is inside the SLA), the worker posts the chase note and reports `progress` while the order is open, or `ready` when the state is `done` or `cancel`. It does not set `human_action`.

When the model is not installed, or the record is gone, the read returns `unavailable` and a reason. The worker reports that limitation and does not invent a state, a date or a quantity.

## Attention

A human gate uses the Attention the panel already shows. It is not a new control.

The snapshot tool fills `progress.attention` when the signal is `overdue`, `stale` or `shortfall`. The worker copies that string into `orchestrator_report` `human_action` and leaves `state` as `progress`. The Ticket stage becomes person / answer ([003 Execution](003-execution.md)). The banner is 待人工决定 / Attention, and the question is Markdown. The orchestrator delivers it with `orchestrator_reply` purpose `attention`, which posts the question as an internal note on the same record. The worker does not post a second note on that path.

`waiting` is not this gate. It is the executor's idle report after a turn with nothing left to run, and the worker's report tool does not accept it. Do not infer a question from free text. The question is the structured `human_action`, which is also why an empty "please advise" is not a report.

The question always has three options, one recommendation, and the risk. The options are:

1. 继续催 — post another internal chase and keep the planned date.
2. 建议改期给人确认 — a person confirms a new date. The agent does not write it.
3. 升级缺料异常 — record a material shortage for a person. No reschedule and no customer email.

| Signal | When | Recommendation |
| --- | --- | --- |
| `stale` | `write_date` is 24 hours old or older, and no planned date has passed. Without `write_date` this signal cannot fire | 继续催 |
| `overdue` | The planned date is before now. Manufacturing uses `date_deadline`, else `date_finished`. Sales uses `commitment_date`, else `expected_date`. A date-only value counts through the end of that UTC day | 建议改期给人确认 |
| `shortfall` | Overdue on a manufacturing order, and `qty_produced` is below `product_qty` | 升级缺料异常 |

State `done` or `cancel` is on track even when the date is past. A sales-order header has no planned and done quantities, so a sales order never reports `shortfall`. The shortage option is still in the question, because a person may know a shortage the header does not show. The agent does not invent a quantity.

The risk line states that date changes, expediting, customer promises, QC release and payment stay with a person.

## Snapshot fields

Manufacturing, `mrp.production`: `id`, `name`, `state`, `product_id`, `product_qty`, `qty_producing`, `qty_produced`, `date_start`, `date_finished`, `date_deadline`, `origin`, `write_date`.

Sales, `sale.order`: `id`, `name`, `state`, `partner_id`, `date_order`, `commitment_date`, `expected_date`, `origin`, `write_date`.

`write_date` is only the progress-update clock. `date_start` and `date_order` are context. They are not deadlines, and nothing in either list is written back.

CRM Tickets keep the lead tools and the contact whitelist from [009 Odoo](009-odoo.md).

## Non-goals

- No automatic reschedule, expedite, or write of dates and quantities.
- No customer email and no formal shipping notice.
- No stage, owner, revenue, payment or QC tools.
- No second ERP. This is the same Odoo Source kind, Channel and tools.

## Demo

`scripts/odoo-production-e2e.ts` runs poll, snapshot read and one internal note against a live Odoo, without starting Harness. It prints no secrets.

Without `ODOO_DB`, `ODOO_USER` and `ODOO_PASSWORD`, or with `--dry-run`, it prints a skip and exits 0. When `mrp.production` is not installed, or there is no manufacturing order, or the only activity was created by the agent and `ODOO_REQUESTER_USER` / `ODOO_REQUESTER_PASSWORD` are unset, it skips the same way. The agent drops its own activities, so a created activity has to come from the requester login.

```
ODOO_URL=http://127.0.0.1:8069 ODOO_DB=odoo ODOO_USER=… ODOO_PASSWORD=… \
  ODOO_REQUESTER_USER=… ODOO_REQUESTER_PASSWORD=… \
  node --experimental-transform-types scripts/odoo-production-e2e.ts
```

`--mo`, `--activity` and `--after-id` select an order and an activity that already exist. `--after-id` defaults to one below the activity, which is the cursor a running Source would already hold.
