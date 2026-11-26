# Levyline take-home

Thanks for taking the time to do this.

## What you're building

When you buy an apartment, you own the apartment but share the building with everyone else: the roof, lifts, stairs, gardens and insurance. Every year each owner pays a **service charge** towards running it. Most buildings hire a **managing agent**, a company that runs the building and collects that money. Some owners pay late or not at all, and the agent's staff have to chase them: politely, fairly and within the rules.

You'll build **Levyline**, a small app those staff use to do that. In it, staff:

1. **import** a spreadsheet from the agent's accounts system listing every owner and what they owe;
2. open each **owner's page** to see what they owe, email them and read their replies, and record their promises to pay;
3. design **automations** on a canvas that send reminder emails for them.

New to the industry? These are the only terms you need:

| Term | In plain English |
|---|---|
| **Client** | A managing agent that uses Levyline, e.g. Harbour Property Management. One agent looks after several Developments. |
| **Development** | A building or estate, e.g. Harbour View in Dún Laoghaire. |
| **Unit** | One apartment or house in a Development, e.g. Apt A03. |
| **Owner** | A person who owns a Unit. A Unit can have joint owners (often a couple), and one person can own several Units. |
| **Receivable** | One amount an Owner owes for a Unit: the yearly **service charge**, a **sinking fund** contribution (savings for big future repairs like a new roof), an insurance levy, and so on. The agent's export calls these **demands**. |
| **Balance** | What's still unpaid. A **credit note** (a refund) is a negative amount that reduces it. Anything unpaid after its due date is **overdue**, or in **arrears**. |
| **Commitment** | An Owner's promise to pay: everything on one date, or a **payment plan** of instalments. If they miss an instalment, the commitment is **broken**. |
| **Disputed** | The Owner says the charge is wrong, e.g. "my bathroom's been leaking for months". Don't chase it until staff resolve it. |
| **Do not contact** | Nobody may email the Owner, often because a solicitor is acting for them. |

The precise rules are in [`PRODUCT_RULES.md`](PRODUCT_RULES.md).

## Before you start

**Real email, free:** you'll use [Resend](https://resend.com)'s free plan to send real emails to your own inbox and reply to them, so an Owner's conversation works like a chat with you playing the Owner. See [Email set-up](#email-set-up). You can start offline and switch over later.

**Time:** you have up to **3 days** from when you receive this to send it back. There's deliberately more here than most people will polish in that time, so prioritise: a working end-to-end flow beats three perfect screens. When you stop, tell us what you'd do next.

**AI tools:** use whatever you normally would. We recommend **Claude Code with Opus 5.5**. If you already have a subscription, **Codex with GPT-6** is a good alternative. In your README, tell us where they helped and where you had to step in.

An AI model can build the screens below in an afternoon. What separates submissions is whether the app **follows the rules in [`PRODUCT_RULES.md`](PRODUCT_RULES.md)** with messy data, repeated webhooks, a flaky email provider and real replies. We test against those rules, so read them before you start.

We'd suggest watching Matt Pocock's [complete AI coding workflow, end to end](https://www.youtube.com/watch?v=M6mYodf0dJM&t=37s) before you start. It's close to how we work: grill the idea, write a spec, break it into tickets, implement, then code review.

---

## Getting started

You need Node.js 20+ and Postgres 15 or later running locally: [Postgres.app](https://postgresapp.com) on a Mac, `brew install postgresql@17`, or the [Windows installer](https://www.postgresql.org/download/windows/). Then create a database with `createdb levyline`.

```bash
# 1. Create your own copy: click "Use this template" on GitHub, then clone it
npm install
cp .env.example .env.local   # then set DATABASE_URL to your database
npm run dev                  # http://localhost:3000
```

Check http://localhost:3000/api/health returns `"ok": true`.

### What's in the starter

| Path | What it is |
|---|---|
| `data/owners-and-receivables.csv` | A managing agent's export: one row per Receivable, with the Unit and its Owners. **Some rows are bad, missing, duplicated or ambiguous on purpose.** |
| `data/owners-and-receivables-update.csv` | The same agent's next export, a week later. Use it to test importing again. |
| `PRODUCT_RULES.md` | The business rules. Read them first. |
| `templates/*.md` | Four email templates with `{{placeholders}}` |
| `src/lib/email.ts` | The email boundary: `sendEmail()` and `getReceivedEmail()`. Works offline, or through Resend. **Don't modify it.** |
| `src/app/api/webhooks/resend/route.ts` | Where replies arrive. A stub for you to finish. |
| `scripts/simulate-reply.mjs` | `npm run email:simulate-reply` pretends an owner replied, so you can build replies offline. |
| `src/lib/templates.ts` | Loads the templates and lists their placeholders |
| `src/lib/db.ts` | A Postgres connection pool. Use it, or bring your own ORM / query builder. |
| `src/app/*` | An app shell with a sidebar and a placeholder page for each route. Replace them with your own. |
| `src/lib/nav.ts` | The sidebar routes. Add, rename or remove routes here. |
| `src/components/ui/*` | [shadcn/ui](https://ui.shadcn.com) components. Add more with `npx shadcn@latest add <name>`. |
| `migrations/` | Empty. Your schema goes here. |

The stack is Next.js, React, TypeScript, Postgres, [React Flow](https://reactflow.dev) (`@xyflow/react`) and [Resend](https://resend.com), all installed and wired up. The placeholder pages and routes are a starting point, not a spec, so change them however you like. There are **no database tables**: designing the schema is part of the task.

**Styling:** use [Tailwind CSS](https://tailwindcss.com/docs) for styling, and [shadcn/ui](https://ui.shadcn.com/docs/components) for the building blocks: tables, forms, dialogs, tabs, badges and so on. They're battle-tested and accessible, so reach for one before writing your own. Some are already in `src/components/ui/`; add more with `npx shadcn@latest add <name>`.

You're free to put your own theme and style on it if you like, but it's not a priority.

Useful commands: `npm run typecheck`, and `psql levyline` for a database shell.

---

These three parts mirror how a real collections product works, simplified. They say what staff need to be able to do, not how to build it: layout, schema and wording are up to you.

## Part 1: Import (required)

A managing agent sends us an export from their accounts system. Each row is one Receivable (the export calls it a demand) on one Unit, with that Unit's Owners and their contact details. The same Owner and Unit appear on many rows.

- Staff **upload** the file, **map** its columns to your fields (pre-fill the obvious ones), and see a **preview** before anything is saved: what will be created or updated, what you tidied, and which rows will be skipped and why.
- Rows that look like the **same person** are shown together. Staff confirm a merge; nothing merges silently.
- Owners with no usable email are flagged: automations can't reach them.
- **Importing again** updates rather than duplicates. A change staff made in Levyline (say, a corrected email) survives a re-import unless the file itself changed that field.
- Units missing from a new file are listed, and staff choose whether to archive them.
- Test re-importing with `data/owners-and-receivables-update.csv`: some rows are fixed, payments have come in, a Unit has a new Owner, one Unit is gone and one Owner's email has changed.
- Skipped rows can be downloaded as a CSV with the reason.

Rules 1 to 4 in `PRODUCT_RULES.md` apply.

## Part 2: Owners (required)

This is where staff spend their day.

### Owners list

One row per Owner: name, balance, status (for example in dispute, do not contact, commitment active), Developments and Units, email, phone, and when they last messaged. Staff can search, sort by balance or last message, and filter by status or missing contact details. A row opens the Owner's page.

### Owner page

- **Header:** who they are, their contact details, and badges for anything staff must know first (disputed, do not contact, in an automation, commitment broken).
- **Overview:** the balance per Client and a breakdown of their Receivables by Development and Unit: type, period, due date, amount, paid, outstanding, and how overdue.
- **Conversation:** an email thread with the Owner, like a chat. Staff write a message or start from a template, and the Owner's replies appear in the same thread. A failed send says so and can be retried. Rules 5 to 7 apply, and read **Replies** below.
- **Timeline:** everything that has happened, newest first: imported or updated, messages, replies, commitments, automation steps and status changes.
- **Actions** staff can take from the page: record a **commitment** (a promise to pay on one date, or a payment plan of instalments; rules 11 to 16), mark a Receivable as **disputed** or clear it, set **do not contact**, and **pause or resume** automation for this Owner.

### Replies

Read the comment at the top of `src/lib/email.ts` first. Every email is redirected to your own inbox, so every reply comes back **from you**. You need another way to know whose reply it is: the `replyTo` option of `sendEmail()` and your Resend receiving domain are a good place to start.

Build it offline with `npm run email:simulate-reply` (its `--deliveries 2` option sends the same webhook twice, as real providers sometimes do). Then follow **Email set-up** below and test it for real: message an Owner, reply from your own email client, and watch it land on their page.

## Part 3: Automations (required)

Staff design how Owners are chased on a canvas, then turn it on. We recommend **[React Flow](https://reactflow.dev)** (`@xyflow/react`, already installed); its [drag and drop](https://reactflow.dev/examples/interaction/drag-and-drop), [custom nodes](https://reactflow.dev/learn/customization/custom-nodes) and [save and restore](https://reactflow.dev/examples/interaction/save-and-restore) examples cover most of it.

- **Steps**, dragged from a library onto the canvas between a **Start** and an **End**:
  - **Send email** from a template, which staff can edit and preview with a real Owner's data;
  - **Wait** a number of minutes;
  - **Branch** on a yes/no question about the Owner, such as "Has replied?", "Has a commitment?" or "Balance over €1,000?".
- **Validate** before it can go live (connected, no dead ends, both exits of every Branch used), and say what to fix. **Save** it and load it back.
- **Turn it on** for the Owners you choose. Each Owner moves through it on their own, and their page shows where they are and what was sent. A Branch answers from the Owner's data at that moment.
- **Never send what the rules forbid.** Rules 8 to 10 and 14 decide who can be emailed and when; an Owner who's held back shows why on their page. See the end of `PRODUCT_RULES.md` for testing the time rules without waiting.
- `sendEmail()` fails sometimes. Retry sensibly, and never email the same Owner twice for one step. If you stop `npm run dev` halfway through a Wait, Owners carry on when it starts again.

## Optional extras

Only once Parts 1 to 3 work end to end: a polished extra never makes up for a missing required part. Pick whatever you think would help the person collecting the money most, for example:

- **Dashboard:** what needs attention today: new replies, broken commitments, Owners held back from automation and why, and the balance collected against what's outstanding.
- **Settings:** contact hours and the sender name per Client, editing email templates, and who can do what.
- **Clients and Developments:** pages listing each Client's Developments and Units, with their balances.
- **Unmatched replies:** an inbox of replies that couldn't be matched to an Owner, where staff attach each one to the right person.
- **Pay online:** a payment link in emails, using [Stripe](https://docs.stripe.com/testing) in test mode, that marks Receivables paid.
- **Sign-in:** staff accounts, with the timeline saying who did what.

Tell us in your README which extras you chose and why.

---

## Email set-up

You can build everything offline first. With `RESEND_API_KEY` empty, `sendEmail()` writes emails to `.mailbox/outbox/` and `npm run email:simulate-reply` writes replies to `.mailbox/inbox/` before posting the webhook.

To send and receive real email (we expect you to have done this before you submit):

1. Create a free account at [resend.com](https://resend.com). The free plan covers sending and receiving.
2. Create an API key. Put it in `.env.local` as `RESEND_API_KEY`.
3. Set `EMAIL_REDIRECT_TO` to the email address you signed up with. Without your own domain, Resend only lets `onboarding@resend.dev` send to that address, which is why every email is redirected there.
4. In the Resend dashboard, find your **receiving address** (Emails → Receiving). It looks like `anything@<id>.resend.app`: any address at that domain reaches you. Put the domain in `EMAIL_RECEIVING_DOMAIN`.
5. Give your local app a public URL so Resend can reach it. We recommend [ngrok](https://ngrok.com/download): sign up free, install it, and copy your free domain from the dashboard (Domains). It stays the same every time, so you only set up the webhook once:
   ```bash
   ngrok http --url=<your-domain>.ngrok-free.app 3000
   ```
   No account? `cloudflared tunnel --url http://localhost:3000` ([install](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)) works too, but its URL changes every run, so you'd update the webhook each time. Deploying the app also works.
6. In Resend, add a webhook to `https://<your-url>/api/webhooks/resend` for the `email.received` event. Put its signing secret in `RESEND_WEBHOOK_SECRET`.

Resend's docs: [receiving emails](https://resend.com/docs/dashboard/receiving/introduction), [getting a received email's content](https://resend.com/docs/dashboard/receiving/get-email-content), and [verifying webhooks](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests).

Never commit your API key or webhook secret. `.env.local` is already in `.gitignore`.

---

## Submitting

1. **Make your GitHub repo private** and invite our reviewers, `wardch` and `alinayevstropova`.
2. **Add a README section** to your repo covering:
   - how to run it, including the email set-up and how to control the clock (see the end of `PRODUCT_RULES.md`)
   - your key decisions and trade-offs, and any rule you had to interpret
   - what you'd do with more time
   - where AI tools helped and where you had to step in
3. **Fill in the [submission form](https://docs.google.com/forms/d/e/1FAIpQLSez08boGY028tY3s_SygKkbcK9DaRrTx0YPwgKj-NjRvnvxsQ/viewform)** with your repo link. Please don't send secrets or API keys.

After we've looked at it, we'll book a 30-minute call where you show us your app, and we ask you to change something live.

## What we look at

- **The rules**: we run your app against `PRODUCT_RULES.md`. This counts for more than anything else.
- **Judgement with messy data**: what you fix, what you skip, and why.
- **The Owner page**: a staff member can see where an Owner stands at a glance, message them, and record a commitment. A real reply lands on the right Owner's page, once, in the right conversation.
- **Automations**: Owners progress independently, failures are visible, nobody is emailed twice, and automations survive a restart.
- **Schema and code**: readable, typed and sensibly structured, not over-engineered. Tests where they matter most.
- **UX**: the import preview and Owner page are clear, and the canvas is pleasant to use.
- **Communication**: your README makes the trade-offs clear.

Everything in this repo is fictional. No real people, managing agents or addresses.

---

# Submission notes

## Running it

```bash
npm install
cp .env.example .env.local      # set DATABASE_URL, e.g. postgres://localhost/levyline
createdb levyline
npm run dev                     # applies migrations, then starts Next.js and the automation worker
npm test                        # 31 tests; uses its own database, levyline_test, rebuilt each run
```

- **Schema**: plain SQL in `migrations/`, applied in order by `scripts/migrate.mjs` (`npm run db:migrate`; `npm run db:reset` drops and rebuilds). `npm run dev` runs it first, so a fresh clone works.
- **Try it fast**: Import → “Use a sample: owners-and-receivables.csv” → decide the one suggested merge → Import. Then import the update file the same way.
- **Email, offline**: leave `RESEND_API_KEY` empty. Every sent email in an owner's conversation has a **Simulate a reply** button (and **×2** to deliver the webhook twice). `npm run email:simulate-reply -- --to reply+<token>@reply.levyline.local` also works; the token is on each sent message (`messages.reply_token`).
- **Email, for real**: set `RESEND_API_KEY`, `EMAIL_REDIRECT_TO`, `EMAIL_RECEIVING_DOMAIN` and `RESEND_WEBHOOK_SECRET` as in *Email set-up* above, and point the Resend `email.received` webhook at `/api/webhooks/resend` through ngrok.

### Controlling the clock

Everything time-based (contact hours, one email a day, Waits, instalment dates, missed payments) reads one app clock (`src/lib/clock.ts`), never `new Date()`.

- **In the app**: *Settings* → set “now”, skip ahead (+1 hour … +1 week), set how many real minutes a day lasts, freeze, or go back to real time.
- **In `.env.local`**: `LEVYLINE_NOW=2026-12-01T09:00:00Z` (start the clock there), `LEVYLINE_DAY_MINUTES=5` (a day lasts 5 real minutes; Waits and contact hours scale with it), `LEVYLINE_FREEZE=1`.

The clock's anchor is stored in Postgres, so stopping `npm run dev` mid-Wait and starting again carries on rather than jumping back.

## How the rules are kept

| Rule | Where | How |
|---|---|---|
| 1 Never guess | `src/lib/import/normalize.ts` | `1.340,00`, `one thousand`, blank amounts and impossible dates (`31/09`) skip the row with a reason. Day/month order is a **file-level decision staff confirm** on the mapping step: we pre-select day-first only when the file proves it (`31/10/2026`), and say so. With no confirmed order, swappable dates are skipped. A demand that appears twice with different amounts (D-1049) skips both rows. |
| 2 No silent merges | `plan.ts` step 5 | People are recognised by (name, email), or (name, unit) with no email. Same name with a different email or unit is a **suggestion**; the Import button stays disabled until staff decide each one. A shared email is never a reason to merge (Liam Gallagher / Úna Daly). |
| 3 Idempotent | `owner_identities`, unique `(client, demand_ref)` | Re-importing the same file plans zero changes (tested). |
| 3 Staff edits survive | `owners.imported`, `receivables.imported` | Each row keeps a snapshot of what the file last said. A field is only overwritten when the file's value changed since then. |
| 4 Notes matter | `readNoteFlags()` | “DNC / solicitor acting” → do not contact; “disputed” → receivable disputed; “deceased” → owner flagged, never automated; “sold” → that owner isn't chased for that unit. All shown on the owner page. Imports only ever *add* these flags; clearing them is a staff decision. |
| 5 Do not contact | `deliver()` in `messaging.ts` | Checked in the API, in the UI, and again at the moment of sending, whoever queued the email. Commitments can still be recorded. |
| 6 Joint owners | Composer “also send to joint owners” | Each recipient gets their own message, thread and reply address, so each reply belongs to them. |
| 7 Replies | `/api/webhooks/resend` | Every email's Reply-To is `reply+<token>@<receiving domain>`; the token maps to the message, owner and thread. Signature verified, deduplicated on Resend's email id. Unknown token → **Unmatched replies** page, where staff attach it. Owner pages refresh every 10 s. |
| 8 Who's chased | `automatedEmailVerdict()` in `rules.ts` | Never DNC, deceased, no usable email, balance ≤ 0; only receivables that are due, undisputed, not in an active commitment and not on a sold unit. |
| 9 Hours and one a day | `rules.ts`, `automated_email_days` | Mon–Sat 08:00–20:00 Europe/Dublin. One automated email per owner per Irish date, enforced by a primary key on `(owner, day)`, so two automations can't both win. |
| 10 Reply pauses | `onOwnerReplied()` | Sets `automation_paused` until staff press Resume. |
| 11–13 Commitments | `validateCommitment()` | One client, ≤ outstanding, 1–12 payments, future and increasing dates, first within 30 days, one active per client (also a partial unique index). The same function validates in the dialog as staff type. |
| 14 | `chaseable()` | Committed receivables are skipped; others for the same owner can still be chased. |
| 15 Missed | `breakMissedCommitments()` | Unpaid 3 days after its date → commitment broken (checked by the worker and on page load). |
| 16 Confirmation | `createCommitment()` | Sends `commitment-confirmation` unless DNC or no usable email; the timeline says which. |

### Automations

- A Postgres-backed worker (`src/lib/automation/engine.ts`, started from `src/instrumentation.ts`) wakes every 3 s and moves each due owner on. All state (current step, wake time, steps done) is in the database, so a restart loses nothing. An advisory lock means only one worker runs at a time.
- **Never twice per step**: `enrollment_steps` is unique per (enrollment, step), and the message id is the provider idempotency key. A failed send is retried with back-off (up to 5 attempts) on the *same* message; after that the owner shows **Failed** with a Retry button.
- Owners run the **version** of the graph that was live when they joined; editing the draft doesn't move anyone mid-way.
- Validation: one Start, an End, every step reachable, no dead ends, both Branch exits used, no loops, known placeholders only.
- Anyone held back stays on the step with the reason on their page (and on the dashboard), and is re-checked automatically.

## Decisions and interpretations

- **Owner Email/Phone belong to Owner 1.** The export has one contact column; joint owners named in *Owner 2* get no email (so they're flagged).
- **A unit's owners** are everyone named on any of its rows. Someone no longer listed (Cathal Lynch on RI-N04) is removed from that unit, which the preview warns about.
- **Same name on a unit someone already owns** is treated as the same person on re-import (this is how Deirdre Dunne's new email arrives as an *update*). Within one file it's only a suggestion.
- **Overpayments** (D-1112, paid 2000 on 1875) are imported as they are and count as credit; the preview flags them.
- **€1,495.00** is read (dot decimal, like the rest of the file) and noted as tidied; **1.340,00** is not.
- **Missing contact values never blank a field**: if MI-106 leaves the file, Declan Kennedy keeps the email it carried.
- **Balance for rule 8** is per Client (the automation's client), since money owed to one Client can't pay another's.
- **Deceased** owners aren't emailed by automations; staff can still write by hand (e.g. to the estate).
- **“Has replied?”** means a reply since the owner joined that automation.
- **Archived units** drop out of balances and chasing but keep their history.

## What I'd do next

- Unit tests for the canvas interactions, and an end-to-end test (Playwright) of import → message → reply → automation.
- Per-client contact hours, sender name and editable templates in the database (templates are still files).
- Staff sign-in so the timeline says who did what.
- Pay online (Stripe test mode) to mark receivables paid without waiting for the next export.
- In local mail mode a crash in the ~200 ms of a send could, in theory, resend once (Resend's idempotency key covers the real provider). I'd check `.mailbox/outbox` for the key before retrying.

## Where AI helped, and where I stepped in

Built with Claude Code (Opus 5.5). It drafted the schema, import planner, rule functions, worker and UI, and the tests. Testing in the browser caught bugs the unit tests hadn't: the svix version here doesn't return the payload from `verify()`; Postgres `jsonb` reorders keys, which made the canvas always say “unsaved”; and the update file exposed that a unit leaving the export would blank an owner's email. Each now has a fix and a test where it mattered.
