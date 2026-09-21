#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

function optionValue(args, name, fallback = '') {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function parseDotenv(content) {
	const values = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}

		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) {
			continue;
		}

		let value = match[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"'))
			|| (value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		values[match[1]] = value.replace(/\\n/g, '\n');
	}
	return values;
}

function parseGmailAccount(value) {
	const line = String(value || '').trim();
	const separatorIndex = line.indexOf('----');
	if (separatorIndex <= 0) {
		return null;
	}

	const email = line.slice(0, separatorIndex).trim().toLowerCase();
	const appPassword = line.slice(separatorIndex + 4);
	if (!/^[^@\s]+@gmail\.com$/i.test(email) || !appPassword) {
		return null;
	}

	return { email, appPassword };
}

function parseAccountList(value) {
	return String(value || '')
		.replace(/\\n/g, '\n')
		.split(/[\r\n,]+/)
		.map(parseGmailAccount)
		.filter(Boolean);
}

const args = process.argv.slice(2);
const envFile = optionValue(
	args,
	'--env-file',
	'/Users/lhiro/Desktop/project/research/codex-team-oauth/.env',
);
const env = parseDotenv(await readFile(envFile, 'utf8'));
const endpoint = optionValue(args, '--url', env.XI_MAIL_URL || env.XI_MAIL_BASE_URL || '');
const adminToken = optionValue(args, '--token', env.XI_MAIL_ADMIN_AUTH || '');
const ownerEmail = optionValue(args, '--owner', env.XI_MAIL_LOGIN_EMAIL || '');
const label = optionValue(args, '--label', env.XI_MAIL_IMPORT_LABEL || 'codex-team-oauth-gmail');
const chunkSize = Math.min(Math.max(Number(optionValue(args, '--chunk-size', '50')) || 50, 1), 100);
const dryRun = args.includes('--dry-run');
const imapHost = optionValue(args, '--imap-host', env.GMAIL_IMAP_HOST || 'imap.gmail.com');
const imapPort = Number(optionValue(args, '--imap-port', env.GMAIL_IMAP_PORT || '993')) || 993;

const accounts = parseAccountList(env.GMAIL_ACCOUNTS);
const singleAccount = parseGmailAccount(
	`${env.GMAIL_ADDRESS || ''}----${env.GMAIL_IMAP_PASSWORD || ''}`,
);
if (singleAccount && !accounts.some(account => account.email === singleAccount.email)) {
	accounts.push(singleAccount);
}

const deduped = new Map();
for (const account of accounts) {
	if (!deduped.has(account.email)) {
		deduped.set(account.email, account);
	}
}

const records = [...deduped.values()].map(account => ({
	email: account.email,
	password: account.appPassword,
	provider: 'gmail',
	protocol: 'imap',
	authType: 'app_password',
	settings: {
		source: 'codex-team-oauth',
		credentialFlow: 'external-runner',
		imapHost,
		imapPort,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 465,
	},
	metadata: {
		source: 'codex-team-oauth',
		imapHost,
		imapPort,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 465,
	},
}));

console.log(JSON.stringify({
	envFile,
	accounts: records.length,
	duplicatesRemoved: accounts.length - records.length,
	provider: 'gmail',
	protocol: 'imap',
	authType: 'app_password',
	imapHost,
	imapPort,
}, null, 2));

if (dryRun) {
	process.exit(0);
}

if (!endpoint || !adminToken) {
	throw new Error('请通过 --url/--token 或 env 文件中的 XI_MAIL_URL/XI_MAIL_ADMIN_AUTH 提供导入接口和全局令牌');
}

for (let index = 0; index < records.length; index += chunkSize) {
	const chunk = records.slice(index, index + chunkSize);
	const response = await fetch(endpoint.replace(/\/$/, '') + '/api/admin/mail/connections/import', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-admin-auth': adminToken,
		},
		body: JSON.stringify({
			records: chunk,
			ownerEmail,
			label,
		}),
	});

	let responseBody = {};
	try {
		responseBody = await response.json();
	} catch (error) {
		responseBody = { message: response.statusText };
	}

	if (!response.ok || responseBody.code >= 400) {
		throw new Error(`第 ${index + 1}-${index + chunk.length} 个 Gmail 账号导入失败：${responseBody.message || response.statusText}`);
	}

	const summary = responseBody.data || responseBody;
	console.log(JSON.stringify({
		range: `${index + 1}-${index + chunk.length}`,
		created: summary.created || 0,
		updated: summary.updated || 0,
		skipped: summary.skipped || 0,
		conflict: summary.conflict || 0,
		invalid: summary.invalid || 0,
	}));
}
