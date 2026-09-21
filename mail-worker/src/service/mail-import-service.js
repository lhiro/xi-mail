import { eq, sql } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { isDel } from '../const/entity-const';
import account from '../entity/account';
import mailConnection from '../entity/mail-connection';
import orm from '../entity/orm';
import { t } from '../i18n/i18n';
import emailUtils from '../utils/email-utils';
import { getMailAdapter } from './mail-adapter-registry';
import mailConnectionService from './mail-connection-service';
import userService from './user-service';

function normalizeLineRecord(rawLine) {
	const line = String(rawLine || '').replace(/\r$/, '');
	if (!line.trim()) {
		return null;
	}

	const separatorIndex = line.indexOf('----');
	if (separatorIndex <= 0) {
		return null;
	}

	const email = line.slice(0, separatorIndex).trim().toLowerCase();
	const values = line.slice(separatorIndex + 4).split('----');
	if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
		return null;
	}

	if (values.length >= 3) {
		const firstCandidate = values[1];
		const secondCandidate = values[2];
		const firstLooksLikeClientId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firstCandidate);
		const secondLooksLikeClientId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secondCandidate);
		const looksLikeOAuthRecord = firstLooksLikeClientId
			|| secondLooksLikeClientId
			|| firstCandidate.length > 100
			|| secondCandidate.length > 100;
		if (looksLikeOAuthRecord) {
			return {
				email,
				secret: firstLooksLikeClientId || !secondLooksLikeClientId ? secondCandidate : firstCandidate,
				clientId: firstLooksLikeClientId || !secondLooksLikeClientId ? firstCandidate : secondCandidate,
				provider: 'outlook',
				protocol: 'graph',
				authType: 'oauth2',
			};
		}
	}

	const password = line.slice(separatorIndex + 4);
	if (!password) {
		return null;
	}

	return {
		email,
		secret: password,
		provider: 'outlook',
		protocol: 'imap',
		authType: 'password',
	};
}

function normalizeRecord(record) {
	if (!record || typeof record !== 'object') {
		return null;
	}

	const email = String(record.email || '').trim().toLowerCase();
	const refreshToken = typeof record.refreshToken === 'string'
		? record.refreshToken
		: typeof record.refresh_token === 'string' ? record.refresh_token : '';
	const password = typeof record.password === 'string' ? record.password : '';

	if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
		return null;
	}

	if (refreshToken) {
		return {
			email,
			secret: refreshToken,
			clientId: String(record.clientId || record.client_id || '').trim(),
			clientSecret: String(record.clientSecret || record.client_secret || ''),
			provider: String(record.provider || 'outlook').trim().toLowerCase(),
			protocol: String(record.protocol || 'graph').trim().toLowerCase(),
			authType: 'oauth2',
			scopes: record.scopes,
			tokenEndpoint: record.tokenEndpoint || record.token_endpoint,
			metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
				? record.metadata
				: {},
			settings: record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings)
				? record.settings
				: {},
		};
	}

	if (!password) {
		return null;
	}

	return {
		email,
		secret: password,
		provider: String(record.provider || 'imap').trim().toLowerCase(),
		protocol: String(record.protocol || 'imap').trim().toLowerCase(),
		authType: String(record.authType || record.auth_type || 'app_password').trim().toLowerCase(),
		metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
			? record.metadata
			: {},
		settings: record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings)
			? record.settings
			: {},
	};
}

function recordsFromParams(params) {
	if (Array.isArray(params?.records)) {
		return params.records.map(normalizeRecord);
	}

	const accountString = typeof params?.accountString === 'string'
		? params.accountString
		: typeof params?.account_string === 'string' ? params.account_string : '';

	return accountString.split('\n').map(normalizeLineRecord);
}

const mailImportService = {
	async importBatch(c, params = {}) {
		const ownerEmail = String(params.ownerEmail || params.owner_email || c.env.admin || '').trim().toLowerCase();
		const owner = await userService.selectByEmail(c, ownerEmail);
		if (!owner) {
			throw new BizError(t('mailImportOwnerNotFound'), 404);
		}

		const records = recordsFromParams(params).filter(Boolean).slice(0, 500);
		const label = String(params.label || 'imported-mail').trim().slice(0, 60);
		const summary = {
			total: records.length,
			created: 0,
			updated: 0,
			skipped: 0,
			invalid: 0,
			conflict: 0,
		};

		for (const record of records) {
			try {
				const accountRow = await orm(c).select().from(account).where(
					sql`${account.email} COLLATE NOCASE = ${record.email}`,
				).get();

				let ownedAccount = accountRow;
				if (ownedAccount && ownedAccount.userId !== owner.userId && ownedAccount.isDel === isDel.NORMAL) {
					summary.conflict += 1;
					continue;
				}

				if (!ownedAccount) {
					ownedAccount = await orm(c).insert(account).values({
						email: record.email,
						name: emailUtils.getName(record.email),
						userId: owner.userId,
						isDel: isDel.NORMAL,
					}).returning().get();
					summary.created += 1;
				} else if (ownedAccount.isDel === isDel.DELETE) {
					ownedAccount = await orm(c).update(account).set({
						userId: owner.userId,
						isDel: isDel.NORMAL,
						name: emailUtils.getName(record.email),
					}).where(eq(account.accountId, ownedAccount.accountId)).returning().get();
					summary.updated += 1;
				}

				let connection = await orm(c).select().from(mailConnection).where(
					eq(mailConnection.accountId, ownedAccount.accountId),
				).get();

				if (!connection) {
					connection = await mailConnectionService.create(c, {
						accountId: ownedAccount.accountId,
						provider: record.provider,
						protocol: record.protocol,
						authType: record.authType,
						label,
						settings: {
							source: 'batch-import',
							credentialFlow: record.protocol === 'imap' && record.authType !== 'oauth2'
								? 'external-runner'
								: 'provider-native',
							...record.settings,
						},
					}, owner.userId);
				}

				const connectionMatches = connection.provider === record.provider
					&& connection.protocol === record.protocol
					&& connection.authType === record.authType;
				if (!connectionMatches) {
					const canUpgradeOutlookToken = connection.provider === 'outlook'
						&& record.provider === 'outlook'
						&& record.authType === 'oauth2';
					if (!canUpgradeOutlookToken) {
						summary.conflict += 1;
						continue;
					}
					connection = await mailConnectionService.reconfigure(c, connection.connectionId, {
						provider: record.provider,
						protocol: record.protocol,
						authType: record.authType,
					}, owner.userId);
				}

				await mailConnectionService.upsertCredential(c, connection.connectionId, {
					credentialType: record.authType,
					secret: record.secret,
					clientId: record.clientId,
					clientSecret: record.clientSecret,
					tokenEndpoint: record.tokenEndpoint,
					scopes: record.scopes,
					metadata: record.metadata,
				}, owner.userId);

				const adapter = getMailAdapter({
					provider: record.provider,
					protocol: record.protocol,
					authType: record.authType,
				});
				if (record.authType === 'password' || !adapter) {
					await orm(c).update(mailConnection).set({
						status: 'pending',
						lastSyncStatus: 'staged',
						lastSyncError: '',
						updateTime: new Date().toISOString(),
					}).where(eq(mailConnection.connectionId, connection.connectionId)).run();
				}
			} catch (error) {
				summary.skipped += 1;
			}
		}

		summary.invalid = (params?.records || params?.accountString || params?.account_string)
			? Math.max(0, (Array.isArray(params?.records)
				? params.records.length
				: String(params.accountString || params.account_string).split('\n').filter(line => line.trim()).length) - records.length)
			: 0;

		return summary;
	},
};

export default mailImportService;
