# Mail provider architecture

Xi-Mail now treats an external mailbox as a provider connection instead of
embedding Outlook-specific fields in `account`.

## Core model

- `account`: Xi-Mail mailbox owner and existing local-mail identity.
- `mail_connection`: provider, protocol, auth type, display label, settings,
  and sync status.
- `mail_credential`: encrypted refresh token, app password, password, access
  token, OAuth client data, and scopes.
- `mail_message_ref`: maps a provider message ID to the existing `email` row.
- `mail_sync_task`: idempotency and in-flight protection for sync operations.

Secrets are encrypted with AES-GCM using the Worker secret
`mail_credential_encryption_key`. The secret is never returned by an API
response.

## Provider matrix

| Provider | Protocol | Authentication | Current state |
| --- | --- | --- | --- |
| Outlook / Microsoft 365 | Graph | OAuth2 | Adapter implemented |
| Outlook / Microsoft 365 | IMAP | Password | Staged for external auth runner |
| Gmail | Gmail API | OAuth2 | Adapter implemented |
| Gmail | IMAP | App Password | Adapter implemented; imported records are ready |
| Generic IMAP / SMTP | IMAP / SMTP | App Password or password | Registry-ready, adapter pending |

This keeps Gmail App Password and custom IMAP support in the same connection
model without adding provider-specific columns or tables.

## API

Authenticated user routes:

- `GET /api/mail/providers`
- `GET /api/mail/connections`
- `POST /api/mail/connections`
- `PUT /api/mail/connections/:connectionId`
- `PUT /api/mail/connections/:connectionId/credential`
- `DELETE /api/mail/connections/:connectionId/credential`
- `POST /api/mail/connections/:connectionId/sync`

Global-token route for staged/batch imports:

- `POST /api/admin/mail/connections/import`

The import endpoint accepts either:

- `accountString`: newline-separated `email----secret` records; or
- `records`: structured records with `email`, `password` or
  `refreshToken`, plus optional OAuth client fields.

It returns counts only and never returns imported secrets.

The Gmail API adapter uses the provider OAuth refresh-token flow. Gmail App
Passwords use a Worker TCP/TLS IMAP adapter with encrypted credentials and
IMAP connection metadata. The IMAP adapter fetches bounded five-message
batches, reports the remote folder total separately from the current page
size, supports a page cursor, and normalizes MIME messages into Xi-Mail's
existing `email` table. Sync responses use `fetched` for the current page and
`total` for the provider-reported folder total when available.

External messages are normalized in received-time order before insertion.
The inbox list is ordered by `create_time DESC, email_id DESC`, so the newest
message remains at the top even when a provider returns newest-first pages.

Cloudflare Queue is used for supported background sync:

- Queue: `xi-mail-sync`
- Producer binding: `MAIL_SYNC_QUEUE`
- Consumer: max batch 1, timeout 10 seconds, max retries 3
- Cron schedules ready connections and the queue consumer performs the sync

## Deployment

Set the encryption secret once per Worker:

```bash
npx wrangler secret put mail_credential_encryption_key
```

Then deploy the Worker and run the D1 `v4_2DB` migration. The reusable local
import helper is:

```bash
node scripts/import-company-mailboxes.mjs --validate-only \
  --file /path/to/mailboxes.txt
```

For a real import, provide `XI_MAIL_URL` and `XI_MAIL_ADMIN_TOKEN`; the
helper uploads chunks and prints only aggregate counts.

To migrate the Gmail App Password records from the existing OAuth team's
environment file without printing secrets:

```bash
node scripts/import-gmail-env.mjs \
  --env-file /path/to/codex-team-oauth/.env
```

The migration deduplicates by Gmail address and imports them as
`gmail:imap:app_password` with encrypted credentials and staged status.

For Outlook accounts that need OAuth refresh tokens, use the reusable protocol
runner:

```bash
node scripts/outlook-oauth-tokens.mjs \
  --env-file /path/to/codex-team-oauth/.env \
  --file /path/to/outlook.txt \
  --recovery-email recovery@example.com \
  --import \
  --sync
```

See [Outlook OAuth token runbook](OUTLOOK_OAUTH_RUNBOOK.md) for the full
operator workflow, recovery-code matching rules, and output files.
