# Odoo CRM activities

V0 listens to Odoo `mail.activity` rows on `crm.lead` and posts the worker's note back on that lead. It does not patch Odoo. The connection is XML-RPC and the credentials stay in the environment.

This Source is the first implementation of the ERP adapter contract, 010. A later ERP plugs in as its own Source and Channel. Policy, Tickets and the Executor stay.

## Environment

Set these before enabling the plugin. Nothing here is stored in settings.

| Variable | Meaning |
| --- | --- |
| `ODOO_URL` | Base URL. Defaults to `http://127.0.0.1:8069`. |
| `ODOO_DB` | Database name. Required. |
| `ODOO_USER` | Login of the Odoo user the agent acts as. Required. |
| `ODOO_PASSWORD` | That user's password. Required. Never commit it. |

The agent user needs to read `mail.activity` and `crm.lead`, write the contact fields below, and post notes (`mail.message` / `message_post`). On Odoo 20, `crm.lead` has no `mobile` field, so the whitelist does not include it. When manufacturing or sales is installed, the same user also reads `mrp.production` or `sale.order` and posts notes there. Those models have no field whitelist.

## Enable

The bundle inserts `dsh-superagent-odoo` disabled, the same way it inserts Feishu. In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-superagent-odoo
  disabled: false
```

Restart, then in Sources turn **Odoo** on. The first poll records the current highest `mail.activity` id and does not open tickets for older activities.

Under **Eval → On each Source → Odoo**, list the Odoo user ids (integers, as text) that may originate work. An activity becomes an explicit request only when one of those users assigns it to the agent user, on a `crm.lead`, an `mrp.production` or a `sale.order`.

## Sample activity

1. Open a CRM lead in Odoo.
2. As a user who is on the allowed list and who is not the agent user, schedule an activity assigned to the agent user. Put the missing contact in the summary or note, for example `Phone 555-0100, email ada@example.com, contact Ada Lovelace`. An activity the agent user creates is ignored.
3. Within one poll (30 seconds by default) the activity is a Trigger. If the creator is on the allowed list, Eval can open a Ticket.
4. The worker reads the lead with `odoo_search_read`, writes only `phone`, `email_from`, `contact_name`, `partner_name`, `function` and `description`, and posts one internal note with `odoo_message_post`.
5. Success is that note on the lead's chatter, plus the whitelisted fields that the activity actually stated. The worker does not invent a phone, email or name, and does not change stage, owner or revenue.

A reply from the Channel (an acknowledgement) is also an internal note on the same lead. Each outgoing message id is written into the note so a retry does not post it twice.

`scripts/odoo-e2e.ts` runs that path against a live Odoo without starting Harness. A cold poll only records the current highest activity id, so pass `--after-id` as the cursor already held when the activity was created. Credentials stay in the environment and are not printed.

A Harness profile still has to pass GitHub setup before this Source polls: the runtime resolves a repository and an agent `gh` even when the work is an Odoo activity. Put `ODOO_URL`, `ODOO_DB`, `ODOO_USER` and `ODOO_PASSWORD` in the environment of the `dsh` process. The macOS app CLI's process name is `DeepSeek Harness`; `scripts/dsh-superagent` treats that as the service. An installed `dsh` older than `engines.dsh` refuses the bundle until `dsh plugin allow-version` records that exact pair.

The activity id is the Trigger id. Editing the same activity does not open another Ticket. A later activity on the same lead joins that lead's Thread.

Production progress on `mrp.production` and `sale.order` uses this same Source. It is started in `docs/011-sop-production-progress.md`. A database without manufacturing still polls leads.
