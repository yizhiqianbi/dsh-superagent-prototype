---
name: dsh-superagent-odoo
description: Enrich the assigned Odoo CRM lead with odoo_search_read, odoo_write and odoo_message_post.
---

Use this skill only when the ticket started on Odoo. `$DSH_SUPERAGENT_ODOO_MODEL`, `$DSH_SUPERAGENT_ODOO_RES_ID` and `$DSH_SUPERAGENT_ODOO_ACTIVITY` name that lead and the activity. When those variables are empty, this ticket is not an Odoo ticket: do not call the Odoo tools.

The three tools exist only on that worker, and they touch only that `crm.lead`:

- `odoo_search_read` reads the whitelisted fields of the lead. Pass `model` `crm.lead`.
- `odoo_write` writes only `phone`, `email_from`, `contact_name`, `partner_name`, `function` and `description`. `partner_name` is the company and `contact_name` is the person. Copy a value only when the activity text states it. Never invent a phone, email or name. Never write stage, owner, team or revenue.
- `odoo_message_post` posts one short internal note on the lead: which fields were filled, and which stayed empty.

Do not call XML-RPC yourself, and do not open another model or another lead. Acknowledge the activity with `orchestrator_ack` before writing. Finish with `orchestrator_report`.
