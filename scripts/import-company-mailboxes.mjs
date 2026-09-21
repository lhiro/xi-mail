#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

function optionValue(args, name, fallback = '') {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function parseLine(line) {
	const normalizedLine = line.replace(/\r$/, '');
	if (!normalizedLine.trim()) {
		return null;
	}

	const parts = normalizedLine.split('----').map(value => value.trim());
	if (parts.length < 2) {
		return null;
	}

	const email = parts.shift().toLowerCase();
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !parts[0]) {
		return null;
	}

	const clientIdIndex = parts.findIndex(value => (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	));
	if (clientIdIndex >= 0) {
		const refreshToken = parts.find((value, index) => index !== clientIdIndex && value.length > 20);
		if (refreshToken) {
			return {
				email,
				password: parts[0] || '',
				clientId: parts[clientIdIndex],
				refreshToken,
				provider: 'outlook',
				protocol: 'graph',
				authType: 'oauth2',
				_sourceLine: normalizedLine,
			};
		}
	}

	return {
		email,
		password: parts.join('----'),
		provider: 'outlook',
		protocol: 'imap',
		authType: 'password',
		_sourceLine: normalizedLine,
	};
}

const args = process.argv.slice(2);
const filePath = optionValue(args, '--file', process.env.OUTLOOK_FILE || '/Users/lhiro/Downloads/outlook.txt');
const endpoint = optionValue(args, '--url', process.env.XI_MAIL_URL || '');
const adminToken = optionValue(args, '--token', process.env.XI_MAIL_ADMIN_TOKEN || '');
const ownerEmail = optionValue(args, '--owner', process.env.XI_MAIL_OWNER || '');
const label = optionValue(args, '--label', process.env.XI_MAIL_IMPORT_LABEL || 'company-mail');
const chunkSize = Math.min(Math.max(Number(optionValue(args, '--chunk-size', '50')) || 50, 1), 100);
const validateOnly = args.includes('--validate-only');

const content = await readFile(filePath, 'utf8');
const lines = content.split('\n');
const parsed = lines.map(parseLine);
const validRecords = parsed.filter(Boolean);
const uniqueEmails = new Set(validRecords.map(record => record.email));
const oauthRecords = validRecords.filter(record => record.authType === 'oauth2');

console.log(JSON.stringify({
	file: filePath,
	totalLines: lines.filter(line => line.trim()).length,
	valid: validRecords.length,
	unique: uniqueEmails.size,
	oauth: oauthRecords.length,
	password: validRecords.length - oauthRecords.length,
	invalid: lines.filter(line => line.trim()).length - validRecords.length,
}, null, 2));

if (validateOnly) {
	process.exit(0);
}

if (!endpoint || !adminToken) {
	throw new Error('请通过 --url/--token 或 XI_MAIL_URL/XI_MAIL_ADMIN_TOKEN 提供导入接口和全局令牌');
}

for (let index = 0; index < validRecords.length; index += chunkSize) {
	const chunk = validRecords.slice(index, index + chunkSize);
	const response = await fetch(endpoint.replace(/\/$/, '') + '/api/admin/mail/connections/import', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-admin-auth': adminToken,
		},
		body: JSON.stringify({
			records: chunk.map(({ _sourceLine, ...record }) => record),
			ownerEmail,
			label,
		}),
	});

	let responseBody = {};
	try {
		responseBody = await response.json();
	} catch (e) {
		responseBody = { message: response.statusText };
	}

	if (!response.ok || responseBody.code >= 400) {
		throw new Error(`第 ${index + 1}-${index + chunk.length} 行导入失败：${responseBody.message || response.statusText}`);
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
