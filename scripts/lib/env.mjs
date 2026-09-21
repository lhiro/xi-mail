import { readFile } from 'node:fs/promises';

export function optionValue(args, name, fallback = '') {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function hasFlag(args, name) {
	return args.includes(name);
}

export function parseDotenv(content) {
	const values = {};
	for (const rawLine of String(content || '').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}

		const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
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

export async function loadDotenv(filePath) {
	return parseDotenv(await readFile(filePath, 'utf8'));
}

export function maskEmail(email) {
	const [name, domain] = String(email || '').split('@');
	return domain ? `${name.slice(0, 2)}***${name.slice(-2)}@${domain}` : '***';
}

export function parseAccountLine(line) {
	const normalizedLine = String(line || '').replace(/\r$/, '');
	if (!normalizedLine.trim()) {
		return null;
	}

	const separatorIndex = normalizedLine.indexOf('----');
	if (separatorIndex <= 0) {
		return null;
	}

	const email = normalizedLine.slice(0, separatorIndex).trim();
	const password = normalizedLine.slice(separatorIndex + 4);
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) {
		return null;
	}

	return { email, password };
}

export function parseAccountList(content) {
	return String(content || '')
		.split(/\r?\n/)
		.map(parseAccountLine)
		.filter(Boolean);
}

export function numberOption(args, name, fallback) {
	const value = Number(optionValue(args, name, String(fallback)));
	return Number.isFinite(value) ? value : fallback;
}
