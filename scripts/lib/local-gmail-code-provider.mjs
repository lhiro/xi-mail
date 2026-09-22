import { spawn } from 'node:child_process';

const PYTHON = String.raw`
import base64
import email
import email.header
import email.utils
import imaplib
import json
import re
import sys
from datetime import timezone

req = json.load(sys.stdin)
user = req["user"]
password = req["password"]
host = req.get("host") or "imap.gmail.com"
port = int(req.get("port") or 993)
prefix = req["account_email"].split("@", 1)[0][:2]
after_ms = int(req.get("after_ms") or 0)

def decode_header(value):
    parts = []
    for chunk, charset in email.header.decode_header(value or ""):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(chunk)
    return "".join(parts)

def body_text(message):
    chunks = []
    for part in message.walk() if message.is_multipart() else [message]:
        if part.get_content_type() not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            chunks.append(payload.decode(part.get_content_charset() or "utf-8", errors="replace"))
        except Exception:
            continue
    return "\n".join(chunks)

try:
    client = imaplib.IMAP4_SSL(host, port, timeout=20)
    client.login(user, password)
    client.select("INBOX", readonly=True)
    status, data = client.search(None, 'SUBJECT "security code"')
    ids = (data[0] or b"").split()[-40:] if status == "OK" and data else []
    for uid in reversed(ids):
        status, fetched = client.fetch(uid, "(RFC822)")
        raw = b"".join(item[1] for item in fetched if isinstance(item, tuple))
        if not raw:
            continue
        message = email.message_from_bytes(raw)
        sent_ms = 0
        try:
            parsed = email.utils.parsedate_to_datetime(message.get("Date"))
            sent_ms = int(parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp() * 1000)
        except Exception:
            pass
        if after_ms and sent_ms and sent_ms < after_ms - 60000:
            continue
        subject = decode_header(message.get("Subject", ""))
        text = subject + "\n" + body_text(message)
        if not re.search(r"Microsoft account security code|security code", text, re.I):
            continue
        if prefix and not re.search(r"\\b" + re.escape(prefix) + r"\\*{2,}", text, re.I):
            continue
        match = re.search(r"security code\\s*:\\s*(\\d{6,8})", text, re.I)
        if not match:
            match = re.search(r"Microsoft account security code[^0-9]{0,160}(\\d{6,8})", text, re.I)
        if match:
            print(match.group(1))
            break
    client.logout()
except Exception:
    # The caller handles polling/retry; never print credentials or server text.
    pass
`;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function runPython(payload, timeoutMs = 15000) {
	return new Promise((resolve) => {
		const child = spawn('python3', ['-c', PYTHON], { stdio: ['pipe', 'pipe', 'ignore'] });
		let output = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stdout.on('data', chunk => { output += chunk.toString(); });
		child.on('error', () => { clearTimeout(timer); resolve(''); });
		child.on('close', () => { clearTimeout(timer); resolve(output.trim()); });
		child.stdin.end(JSON.stringify(payload));
	});
}

function parseAccounts(value = '') {
	const accounts = new Map();
	for (const item of String(value).split(',')) {
		const [email, password] = item.split('----');
		if (email && password) {
			accounts.set(email.trim().toLowerCase(), password.trim());
		}
	}
	return accounts;
}

export function createLocalGmailCodeProvider({ env, waitSeconds = 90, pollMs = 5000 } = {}) {
	const passwords = parseAccounts(env?.GMAIL_ACCOUNTS || '');
	if (env?.GMAIL_ADDRESS && env?.GMAIL_IMAP_PASSWORD) {
		passwords.set(String(env.GMAIL_ADDRESS).toLowerCase(), String(env.GMAIL_IMAP_PASSWORD));
	}
	const host = env?.GMAIL_IMAP_HOST || 'imap.gmail.com';
	const port = Number(env?.GMAIL_IMAP_PORT || 993);
	return async ({ accountEmail, recoveryEmail, afterMs }) => {
		const user = String(recoveryEmail || '').toLowerCase();
		const password = passwords.get(user);
		if (!password) {
			throw new Error(`local gmail credentials not found for ${user.slice(0, 2)}***`);
		}
		const deadline = Date.now() + waitSeconds * 1000;
		while (Date.now() < deadline) {
			const code = await runPython(
				{ user, password, host, port, account_email: accountEmail, after_ms: afterMs },
				Math.min(15000, Math.max(1000, deadline - Date.now())),
			);
			if (/^\d{6,8}$/.test(code)) {
				return code;
			}
			await sleep(pollMs);
		}
		throw new Error(`local gmail code not found for ${String(accountEmail).slice(0, 2)}***`);
	};
}
