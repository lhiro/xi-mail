import { maskEmail } from './env.mjs';

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function microsoftCodeFromMail(mail, accountEmail) {
	const hay = `${mail.subject || ''}\n${mail.text || ''}\n${mail.content || ''}`;
	const prefix = String(accountEmail || '').split('@')[0].slice(0, 2).toLowerCase();
	if (prefix) {
		const maskedPrefix = new RegExp(`\\b${escapeRegExp(prefix)}\\*{2,}`, 'i');
		if (!maskedPrefix.test(hay)) {
			return '';
		}
	}

	return /security code\s*:\s*(\d{6,8})/i.exec(hay)?.[1]
		|| /Microsoft account security code[^0-9]{0,160}(\d{6,8})/i.exec(hay)?.[1]
		|| '';
}

function normalizeTimeoutMs(value, fallbackMs) {
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return fallbackMs;
	}
	return timeout < 1000 ? timeout * 1000 : timeout;
}

export class XiMailClient {
	constructor({ baseUrl, loginEmail, loginPassword, adminToken, timeoutMs = 45000 }) {
		this.baseUrl = String(baseUrl || 'https://email.lhiro.cn').replace(/\/$/, '');
		this.loginEmail = loginEmail;
		this.loginPassword = loginPassword;
		this.adminToken = adminToken;
		this.timeoutMs = timeoutMs;
		this.authToken = '';
	}

	async request(path, options = {}) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(`${this.baseUrl}/api${path}`, {
				...options,
				signal: controller.signal,
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok || (data.code && data.code !== 200)) {
				throw new Error(`${path} ${response.status} ${data.message || data.error || response.statusText}`);
			}
			return data.data ?? data;
		} finally {
			clearTimeout(timer);
		}
	}

	async login() {
		if (this.authToken) {
			return this.authToken;
		}
		if (!this.loginEmail || !this.loginPassword) {
			throw new Error('missing xi-mail login credentials');
		}
		const login = await this.request('/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: this.loginEmail, password: this.loginPassword }),
		});
		this.authToken = login.token || login;
		return this.authToken;
	}

	async userHeaders(extra = {}) {
		return {
			...extra,
			Authorization: await this.login(),
		};
	}

	async listConnections() {
		const connections = await this.request('/mail/connections', {
			headers: await this.userHeaders(),
		});
		return Array.isArray(connections) ? connections : connections.list || [];
	}

	async findConnectionByEmail(email, provider = '') {
		const targetEmail = String(email || '').toLowerCase();
		const targetProvider = String(provider || '').toLowerCase();
		return (await this.listConnections()).find(connection => (
			String(connection.email || connection.accountEmail || '').toLowerCase() === targetEmail
			&& (!targetProvider || String(connection.provider || '').toLowerCase() === targetProvider)
		));
	}

	async syncConnection(connectionId, body = {}) {
		return this.request(`/mail/connections/${connectionId}/sync`, {
			method: 'POST',
			headers: await this.userHeaders({ 'content-type': 'application/json' }),
			body: JSON.stringify({ folder: 'inbox', top: 10, syncAll: false, ...body }),
		});
	}

	async importConnections(records, { ownerEmail, label = 'imported-mail', chunkSize = 50 } = {}) {
		if (!this.adminToken) {
			throw new Error('missing xi-mail admin token');
		}
		const summary = { total: 0, created: 0, updated: 0, skipped: 0, invalid: 0, conflict: 0 };
		for (let index = 0; index < records.length; index += chunkSize) {
			const chunk = records.slice(index, index + chunkSize);
			const data = await this.request('/admin/mail/connections/import', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-admin-auth': this.adminToken,
				},
				body: JSON.stringify({ ownerEmail, label, records: chunk }),
			});
			for (const key of Object.keys(summary)) {
				summary[key] += Number(data[key] || 0);
			}
		}
		return summary;
	}

	async findMicrosoftSecurityCode({ recoveryEmail, accountEmail, afterMs = 0, waitSeconds = 90, pollMs = 5000 }) {
		const connection = await this.findConnectionByEmail(recoveryEmail, 'gmail');
		if (!connection) {
			throw new Error(`safe gmail connection not found: ${maskEmail(recoveryEmail)}`);
		}
		const connectionId = connection.connectionId || connection.id;
		const deadline = Date.now() + waitSeconds * 1000;
		let lastDetail = '';

		while (Date.now() < deadline) {
			try {
				await this.syncConnection(connectionId, { folder: 'inbox', top: 10, syncAll: false });
				const query = new URLSearchParams({
					size: '10',
					type: 'receive',
					sourceType: 'gmail',
					accountEmail: recoveryEmail,
					subject: 'Microsoft account security code',
				});
				const data = await this.request(`/allEmail/list?${query.toString()}`, {
					headers: await this.userHeaders(),
				});
				for (const mail of data.list || []) {
					const messageMs = Date.parse(mail.createTime || mail.updateTime || mail.create_time || '');
					if (afterMs && Number.isFinite(messageMs) && messageMs < afterMs - 60000) {
						continue;
					}
					const code = microsoftCodeFromMail(mail, accountEmail);
					if (code) {
						return code;
					}
				}
				lastDetail = `no matching code; total=${data.total || 0}`;
			} catch (error) {
				lastDetail = String(error?.message || error).slice(0, 180);
			}
			await sleep(pollMs);
		}
		throw new Error(`gmail code not found for ${maskEmail(accountEmail)}: ${lastDetail}`);
	}
}

export function createXiMailClientFromEnv(env, options = {}) {
	return new XiMailClient({
		baseUrl: options.baseUrl || env.XI_MAIL_BASE_URL || env.XI_MAIL_URL || 'https://email.lhiro.cn',
		loginEmail: options.loginEmail || env.XI_MAIL_LOGIN_EMAIL,
		loginPassword: options.loginPassword || env.XI_MAIL_LOGIN_PASSWORD,
		adminToken: options.adminToken || env.XI_MAIL_ADMIN_AUTH || env.XI_MAIL_ADMIN_TOKEN,
		timeoutMs: normalizeTimeoutMs(options.timeoutMs || env.XI_MAIL_TIMEOUT, 45000),
	});
}

export function createXiMailCodeProvider({ xiMailClient, recoveryEmail, waitSeconds = 90 }) {
	return ({ accountEmail, afterMs }) => xiMailClient.findMicrosoftSecurityCode({
		recoveryEmail,
		accountEmail,
		afterMs,
		waitSeconds,
	});
}
