#!/usr/bin/env node

import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
	hasFlag,
	loadDotenv,
	maskEmail,
	numberOption,
	optionValue,
	parseAccountList,
} from './lib/env.mjs';
import { OutlookProtocolOAuthClient } from './lib/outlook-oauth-client.mjs';
import { createXiMailClientFromEnv, createXiMailCodeProvider } from './lib/ximail-client.mjs';

function usage() {
	return `Usage:
  node scripts/outlook-oauth-tokens.mjs --file /path/outlook.txt --recovery-email name@gmail.com [options]

Options:
  --env-file <path>       dotenv with XI_MAIL_* values (default: codex-team-oauth .env)
  --out-dir <path>        output directory (default: /tmp/xi-mail-outlook-oauth-run)
  --status-file <path>    JSONL result file to select indexes from a previous classifier
  --only-status <csv>     statuses to select from --status-file (default: needs_recovery_email,needs_recovery_code)
  --start-index <n>       original account index lower bound (default: 0)
  --max <n>               max accounts to process (default: 5)
  --max-failures <n>      stop the run after this many non-success results (default: 5; 0 disables)
  --concurrency <n>       workers; default 1 to avoid code collisions
  --wait-seconds <n>      Microsoft code wait window (default: 90)
  --trace                 write sanitized protocol trace JSONL
  --dry-run               only print selected accounts
  --import                import generated token records into xi-mail
  --sync                  sync imported token records after import
  --sync-top <n>          messages per sync request (default: 10)
`;
}

async function loadStatusIndexes(filePath, statuses) {
	if (!filePath || !existsSync(filePath)) {
		return null;
	}
	const selected = new Set();
	for (const line of (await readFile(filePath, 'utf8')).split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		const row = JSON.parse(line);
		if (statuses.has(row.status)) {
			selected.add(Number(row.index));
		}
	}
	return selected;
}

async function loadCompletedIndexes(resultPath) {
	const completed = new Set();
	if (!existsSync(resultPath)) {
		return completed;
	}
	for (const line of (await readFile(resultPath, 'utf8')).split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		const row = JSON.parse(line);
		if (row.status === 'success') {
			completed.add(Number(row.index));
		}
	}
	return completed;
}

async function appendJsonLine(filePath, value) {
	await appendFile(filePath, `${JSON.stringify(value)}\n`);
}

function tokenImportRecord(tokenRecord) {
	return {
		email: tokenRecord.email,
		refreshToken: tokenRecord.refreshToken,
		clientId: tokenRecord.clientId,
		provider: 'outlook',
		protocol: 'graph',
		authType: 'oauth2',
		scopes: tokenRecord.scopes,
		tokenEndpoint: tokenRecord.tokenEndpoint,
		metadata: {
			source: 'outlook-oauth-tokens-script',
			recoveryEmail: tokenRecord.recoveryEmail,
			createdAt: tokenRecord.createdAt,
		},
	};
}

async function syncTokenRecords(xiMail, tokenRecords, { top = 10, concurrency = 2 } = {}) {
	const wanted = new Set(tokenRecords.map(record => record.email.toLowerCase()));
	const connections = await xiMail.listConnections();
	const targets = connections.filter(connection => (
		String(connection.provider || '').toLowerCase() === 'outlook'
		&& String(connection.authType || '').toLowerCase() === 'oauth2'
		&& wanted.has(String(connection.accountEmail || connection.email || '').toLowerCase())
	));

	let cursor = 0;
	let done = 0;
	const results = [];
	async function worker() {
		while (cursor < targets.length) {
			const index = cursor;
			cursor += 1;
			const connection = targets[index];
			try {
				const syncResult = await xiMail.syncConnection(connection.connectionId || connection.id, {
					folder: 'inbox',
					top,
					syncAll: false,
				});
				results[index] = {
					email: maskEmail(connection.accountEmail || connection.email),
					status: 'success',
					fetched: syncResult.fetched || 0,
					created: syncResult.created || 0,
					updated: syncResult.updated || 0,
				};
				console.log(`[sync] ${done + 1}/${targets.length} ${results[index].email} ok fetched=${results[index].fetched} created=${results[index].created}`);
			} catch (error) {
				results[index] = {
					email: maskEmail(connection.accountEmail || connection.email),
					status: 'error',
					error: String(error?.message || error).slice(0, 200),
				};
				console.log(`[sync] ${done + 1}/${targets.length} ${results[index].email} error`);
			}
			done += 1;
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
	return {
		total: targets.length,
		success: results.filter(row => row?.status === 'success').length,
		error: results.filter(row => row?.status === 'error').length,
		fetched: results.reduce((sum, row) => sum + Number(row?.fetched || 0), 0),
		created: results.reduce((sum, row) => sum + Number(row?.created || 0), 0),
		results,
	};
}

const args = process.argv.slice(2);
if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
	console.log(usage());
	process.exit(0);
}

const envFile = optionValue(args, '--env-file', '/Users/lhiro/Desktop/project/research/codex-team-oauth/.env');
const env = {
	...process.env,
	...(existsSync(envFile) ? await loadDotenv(envFile) : {}),
};
const accountFile = optionValue(args, '--file', env.OUTLOOK_FILE || '/Users/lhiro/Downloads/outlook.txt');
const outDir = optionValue(args, '--out-dir', '/tmp/xi-mail-outlook-oauth-run');
const recoveryEmail = optionValue(args, '--recovery-email', env.OUTLOOK_RECOVERY_EMAIL || 'lhiroooa@gmail.com');
const statusFile = optionValue(args, '--status-file', '');
const onlyStatuses = new Set(optionValue(args, '--only-status', 'needs_recovery_email,needs_recovery_code').split(',').map(value => value.trim()).filter(Boolean));
const startIndex = numberOption(args, '--start-index', 0);
const max = numberOption(args, '--max', 5);
const maxFailures = Math.max(0, numberOption(args, '--max-failures', 5));
const concurrency = Math.max(1, numberOption(args, '--concurrency', 1));
const waitSeconds = numberOption(args, '--wait-seconds', 90);
const syncTop = numberOption(args, '--sync-top', 10);
const shouldTrace = hasFlag(args, '--trace');
const dryRun = hasFlag(args, '--dry-run');
const shouldImport = hasFlag(args, '--import');
const shouldSync = hasFlag(args, '--sync');
const resume = !hasFlag(args, '--no-resume');

await mkdir(outDir, { recursive: true });
const resultPath = path.join(outDir, 'results.jsonl');
const tokenPath = path.join(outDir, 'tokens.jsonl');
const summaryPath = path.join(outDir, 'summary.json');
const tracePath = path.join(outDir, 'trace.jsonl');

let accounts = parseAccountList(await readFile(accountFile, 'utf8')).map((account, index) => ({ ...account, index }));
const selectedIndexes = await loadStatusIndexes(statusFile, onlyStatuses);
if (selectedIndexes) {
	accounts = accounts.filter(account => selectedIndexes.has(account.index));
}
accounts = accounts.filter(account => account.index >= startIndex).slice(0, max);
if (resume) {
	const completed = await loadCompletedIndexes(resultPath);
	accounts = accounts.filter(account => !completed.has(account.index));
}

console.log(JSON.stringify({
	accountFile,
	outDir,
	recoveryEmail: maskEmail(recoveryEmail),
	selected: accounts.length,
	startIndex,
	max,
	maxFailures,
	concurrency,
	trace: shouldTrace,
	dryRun,
	import: shouldImport,
	sync: shouldSync,
	samples: accounts.slice(0, 5).map(account => ({ index: account.index, email: maskEmail(account.email) })),
}, null, 2));

if (dryRun) {
	process.exit(0);
}

const xiMail = createXiMailClientFromEnv(env);
const codeProvider = createXiMailCodeProvider({ xiMailClient: xiMail, recoveryEmail, waitSeconds });
const client = new OutlookProtocolOAuthClient({
	clientId: optionValue(args, '--client-id', env.OAUTH_CLIENT_ID || undefined) || undefined,
	trace: shouldTrace ? row => appendJsonLine(tracePath, row) : null,
	log: message => console.log(message),
});

let cursor = 0;
let done = 0;
let failureCount = 0;
let stopReason = '';
const counters = {};
const tokenRecords = [];

async function processAccount(account) {
	try {
		const result = await client.authorize(account, {
			recoveryEmail,
			codeProvider,
			traceContext: { index: account.index, email: maskEmail(account.email) },
		});
		const safeResult = {
			index: account.index,
			email: maskEmail(account.email),
			status: result.status,
			graphMail: result.graphMail ? maskEmail(result.graphMail) : undefined,
			url: result.url,
			detail: result.detail,
		};
		await appendJsonLine(resultPath, safeResult);
		if (result.status === 'success' && result.tokenRecord) {
			tokenRecords.push(result.tokenRecord);
			await appendJsonLine(tokenPath, result.tokenRecord);
			await chmod(tokenPath, 0o600).catch(() => {});
		} else if (result.status !== 'success') {
			failureCount += 1;
			if (maxFailures && failureCount >= maxFailures && !stopReason) {
				stopReason = `max_failures_reached:${failureCount}`;
			}
		}
		counters[result.status] = (counters[result.status] || 0) + 1;
		console.log(`[outlook-oauth] ${done + 1}/${accounts.length} #${account.index} ${maskEmail(account.email)} => ${result.status}`);
	} catch (error) {
		const safeResult = {
			index: account.index,
			email: maskEmail(account.email),
			status: 'error',
			error: String(error?.message || error).slice(0, 300),
		};
		await appendJsonLine(resultPath, safeResult);
		counters.error = (counters.error || 0) + 1;
		failureCount += 1;
		if (maxFailures && failureCount >= maxFailures && !stopReason) {
			stopReason = `max_failures_reached:${failureCount}`;
		}
		console.log(`[outlook-oauth] ${done + 1}/${accounts.length} #${account.index} ${maskEmail(account.email)} => error`);
	} finally {
		done += 1;
	}
}

async function worker() {
	while (cursor < accounts.length && !stopReason) {
		const index = cursor;
		cursor += 1;
		await processAccount(accounts[index]);
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, () => worker()));

const summary = {
	total: done,
	selectedTotal: accounts.length,
	aborted: Boolean(stopReason),
	stopReason,
	failureCount,
	...counters,
	tokenCount: tokenRecords.length,
	resultPath,
	tokenPath: existsSync(tokenPath) ? tokenPath : '',
};

if (shouldImport && tokenRecords.length) {
	summary.importSummary = await xiMail.importConnections(tokenRecords.map(tokenImportRecord), {
		ownerEmail: optionValue(args, '--owner', env.XI_MAIL_LOGIN_EMAIL || ''),
		label: optionValue(args, '--label', 'protocol-outlook-oauth'),
	});
}

if (shouldSync && tokenRecords.length) {
	summary.syncSummary = await syncTokenRecords(xiMail, tokenRecords, {
		top: syncTop,
		concurrency: Math.min(2, concurrency),
	});
}

await writeFile(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
