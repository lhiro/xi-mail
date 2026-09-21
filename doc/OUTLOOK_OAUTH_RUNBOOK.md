# Outlook OAuth token runbook

This repo includes a reusable protocol runner for Outlook / Microsoft account
OAuth authorization. It is intended for authorized mailbox migration and avoids
browser/CDP state so the same flow can be re-run from CI or an ops shell.

## Files

- `scripts/outlook-oauth-tokens.mjs`: CLI entry point.
- `scripts/lib/outlook-oauth-client.mjs`: Microsoft login, recovery proof,
  consent, authorization-code exchange, and Graph `/me` verification.
- `scripts/lib/ximail-client.mjs`: Xi-Mail API client plus recovery-code lookup
  from a configured Gmail mailbox.
- `scripts/lib/http-cookie-client.mjs`: minimal cookie jar for protocol requests.
- `scripts/lib/env.mjs`: dotenv, account-list, and CLI option helpers.

## Account input

The account file uses the same migration format as the import helper:

```text
account@example.com----password
```

Blank lines and malformed lines are ignored. Output files that contain refresh
tokens are written under the selected `--out-dir`; keep that directory outside
source control.

## Prerequisites

1. A Xi-Mail admin/user environment file containing `XI_MAIL_URL` or
   `XI_MAIL_BASE_URL`, `XI_MAIL_LOGIN_EMAIL`, `XI_MAIL_LOGIN_PASSWORD`, and
   `XI_MAIL_ADMIN_TOKEN` when `--import` is used.
2. A Gmail recovery mailbox already imported as a `gmail` connection in Xi-Mail.
3. The recovery mailbox can receive Microsoft security-code messages.

## Dry run

```bash
node scripts/outlook-oauth-tokens.mjs \
  --file /path/to/outlook.txt \
  --status-file /tmp/previous-classifier.jsonl \
  --recovery-email recovery@example.com \
  --max 5 \
  --dry-run
```

The dry run only prints masked accounts and selection settings.

## Generate tokens

```bash
node scripts/outlook-oauth-tokens.mjs \
  --env-file /path/to/.env \
  --file /path/to/outlook.txt \
  --status-file /tmp/previous-classifier.jsonl \
  --recovery-email recovery@example.com \
  --out-dir /tmp/xi-mail-outlook-oauth-run \
  --max 20 \
  --max-failures 5 \
  --concurrency 1 \
  --wait-seconds 120 \
  --trace
```

Use `--concurrency 1` by default. Microsoft sends similar security-code emails
for different accounts, and serialized processing avoids code collisions.
The runner stops after five non-success statuses by default; use
`--max-failures 0` only for a supervised diagnostic run.

## Generate, import, and sync

```bash
node scripts/outlook-oauth-tokens.mjs \
  --env-file /path/to/.env \
  --file /path/to/outlook.txt \
  --recovery-email recovery@example.com \
  --out-dir /tmp/xi-mail-outlook-oauth-run \
  --max 20 \
  --import \
  --sync \
  --sync-top 10
```

The import payload is normalized as `provider=outlook`, `protocol=graph`, and
`authType=oauth2`, so future provider code can reuse the same connection model.

## Recovery-code matching

The Xi-Mail code provider intentionally filters by:

- Gmail connection email and provider type;
- message subject `Microsoft account security code`;
- message timestamp after the protocol request starts;
- the masked account prefix contained in the Microsoft email body.

If Microsoft rejects a submitted code, the runner records
`verify_code_failed` and moves on instead of repeatedly submitting stale codes.
If Microsoft returns the AddProof page again after the recovery email is
submitted, the runner records `add_proof_not_accepted`; this usually means the
account did not reach the security-code page and should be investigated before
continuing a large batch.

## Outputs

- `results.jsonl`: masked per-account status.
- `tokens.jsonl`: refresh-token records; file mode is tightened to `0600`.
- `summary.json`: aggregate counts plus import/sync summaries when enabled.
- `trace.jsonl`: sanitized protocol trace when `--trace` is enabled.
