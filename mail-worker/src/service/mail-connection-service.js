import { and, desc, eq, inArray } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { getMailProviderDefinition, canUseMailConnection, listMailProviderDefinitions } from '../const/mail-provider';
import { isDel } from '../const/entity-const';
import account from '../entity/account';
import mailConnection from '../entity/mail-connection';
import mailCredential from '../entity/mail-credential';
import orm from '../entity/orm';
import { t } from '../i18n/i18n';
import cryptoUtils from '../utils/crypto-utils';

function parseJson(value, fallback) {
	try {
		return value ? JSON.parse(value) : fallback;
	} catch (e) {
		return fallback;
	}
}

function normalizeText(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function normalizeScopes(value) {
	if (Array.isArray(value)) {
		return value.map(item => normalizeText(item)).filter(Boolean);
	}

	if (typeof value === 'string') {
		return value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
	}

	return [];
}

function normalizeMetadata(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	return value;
}

function getEncryptionKey(c) {
	const encryptionKey = c.env.mail_credential_encryption_key || c.env.MAIL_CREDENTIAL_ENCRYPTION_KEY;
	if (!encryptionKey) {
		throw new BizError(t('mailCredentialKeyMissing'), 503);
	}
	return encryptionKey;
}

function connectionView(row, credentialTypes = []) {
	return {
		connectionId: row.connectionId,
		accountId: row.accountId,
		accountEmail: row.accountEmail,
		accountName: row.accountName,
		provider: row.provider,
		protocol: row.protocol,
		authType: row.authType,
		label: row.label,
		status: row.status,
		settings: parseJson(row.settings, {}),
		lastSyncAt: row.lastSyncAt,
		lastSyncStatus: row.lastSyncStatus,
		lastSyncError: row.lastSyncError,
		credentialTypes,
		createTime: row.createTime,
		updateTime: row.updateTime,
	};
}

function credentialView(row) {
	return {
		credentialId: row.credentialId,
		connectionId: row.connectionId,
		credentialType: row.credentialType,
		clientId: row.clientId,
		tokenEndpoint: row.tokenEndpoint,
		scopes: parseJson(row.scopes, []),
		metadata: parseJson(row.metadata, {}),
		accessTokenExpiresAt: row.accessTokenExpiresAt,
		createTime: row.createTime,
		updateTime: row.updateTime,
	};
}

async function getOwnedAccount(c, accountId, userId) {
	const row = await orm(c).select().from(account).where(and(
		eq(account.accountId, accountId),
		eq(account.userId, userId),
		eq(account.isDel, isDel.NORMAL),
	)).get();

	if (!row) {
		throw new BizError(t('mailAccountNotFound'), 404);
	}

	return row;
}

async function getOwnedConnection(c, connectionId, userId) {
	const row = await orm(c)
		.select({
			connectionId: mailConnection.connectionId,
			accountId: mailConnection.accountId,
			accountEmail: account.email,
			accountName: account.name,
			provider: mailConnection.provider,
			protocol: mailConnection.protocol,
			authType: mailConnection.authType,
			label: mailConnection.label,
			status: mailConnection.status,
			settings: mailConnection.settings,
			lastSyncAt: mailConnection.lastSyncAt,
			lastSyncStatus: mailConnection.lastSyncStatus,
			lastSyncError: mailConnection.lastSyncError,
			createTime: mailConnection.createTime,
			updateTime: mailConnection.updateTime,
		})
		.from(mailConnection)
		.innerJoin(account, eq(account.accountId, mailConnection.accountId))
		.where(and(
			eq(mailConnection.connectionId, connectionId),
			eq(account.userId, userId),
			eq(account.isDel, isDel.NORMAL),
		))
		.get();

	if (!row) {
		throw new BizError(t('mailConnectionNotFound'), 404);
	}

	return row;
}

async function getConnection(c, connectionId) {
	const row = await orm(c)
		.select({
			connectionId: mailConnection.connectionId,
			accountId: mailConnection.accountId,
			accountEmail: account.email,
			accountName: account.name,
			userId: account.userId,
			provider: mailConnection.provider,
			protocol: mailConnection.protocol,
			authType: mailConnection.authType,
			label: mailConnection.label,
			status: mailConnection.status,
			settings: mailConnection.settings,
			lastSyncAt: mailConnection.lastSyncAt,
			lastSyncStatus: mailConnection.lastSyncStatus,
			lastSyncError: mailConnection.lastSyncError,
			createTime: mailConnection.createTime,
			updateTime: mailConnection.updateTime,
		})
		.from(mailConnection)
		.innerJoin(account, eq(account.accountId, mailConnection.accountId))
		.where(and(
			eq(mailConnection.connectionId, Number(connectionId)),
			eq(account.isDel, isDel.NORMAL),
		))
		.get();

	if (!row) {
		throw new BizError(t('mailConnectionNotFound'), 404);
	}

	return row;
}

async function getConnectionCredentialTypes(c, connectionIds) {
	if (connectionIds.length === 0) {
		return new Map();
	}

	const rows = [];
	for (let index = 0; index < connectionIds.length; index += 80) {
		const chunk = connectionIds.slice(index, index + 80);
		const chunkRows = await orm(c)
			.select({
				connectionId: mailCredential.connectionId,
				credentialType: mailCredential.credentialType,
			})
			.from(mailCredential)
			.where(inArray(mailCredential.connectionId, chunk))
			.all();
		rows.push(...chunkRows);
	}

	return rows.reduce((result, row) => {
		const types = result.get(row.connectionId) || [];
		types.push(row.credentialType);
		result.set(row.connectionId, types);
		return result;
	}, new Map());
}

const mailConnectionService = {
	listProviders() {
		return listMailProviderDefinitions();
	},

	async list(c, userId) {
		const rows = await orm(c)
			.select({
				connectionId: mailConnection.connectionId,
				accountId: mailConnection.accountId,
				accountEmail: account.email,
				accountName: account.name,
				provider: mailConnection.provider,
				protocol: mailConnection.protocol,
				authType: mailConnection.authType,
				label: mailConnection.label,
				status: mailConnection.status,
				settings: mailConnection.settings,
				lastSyncAt: mailConnection.lastSyncAt,
				lastSyncStatus: mailConnection.lastSyncStatus,
				lastSyncError: mailConnection.lastSyncError,
				createTime: mailConnection.createTime,
				updateTime: mailConnection.updateTime,
			})
			.from(mailConnection)
			.innerJoin(account, eq(account.accountId, mailConnection.accountId))
			.where(and(
				eq(account.userId, userId),
				eq(account.isDel, isDel.NORMAL),
			))
			.orderBy(desc(mailConnection.connectionId))
			.all();

		const credentialTypes = await getConnectionCredentialTypes(c, rows.map(row => row.connectionId));
		return rows.map(row => connectionView(row, credentialTypes.get(row.connectionId) || []));
	},

	async create(c, params, userId) {
		const accountId = Number(params?.accountId);
		const provider = normalizeText(params?.provider).toLowerCase();
		const protocol = normalizeText(params?.protocol).toLowerCase();
		const authType = normalizeText(params?.authType).toLowerCase();
		const label = normalizeText(params?.label).slice(0, 80);
		const definition = getMailProviderDefinition(provider);

		if (!Number.isInteger(accountId) || accountId <= 0) {
			throw new BizError(t('mailAccountNotFound'), 400);
		}

		await getOwnedAccount(c, accountId, userId);

		if (!definition) {
			throw new BizError(t('mailProviderUnsupported'), 400);
		}

		if (!canUseMailConnection({ provider, protocol, authType })) {
			throw new BizError(t('mailConnectionCombinationUnsupported'), 400);
		}

		const settings = params?.settings;
		if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) {
			throw new BizError(t('mailConnectionSettingsInvalid'), 400);
		}

		const existing = await orm(c)
			.select({ connectionId: mailConnection.connectionId })
			.from(mailConnection)
			.where(eq(mailConnection.accountId, accountId))
			.get();

		if (existing) {
			throw new BizError(t('mailConnectionExists'), 409);
		}

		const row = await orm(c).insert(mailConnection).values({
			accountId,
			provider,
			protocol,
			authType,
			label,
			settings: JSON.stringify(settings || {}),
		}).returning().get();

		const accountRow = await getOwnedAccount(c, accountId, userId);
		return connectionView({
			...row,
			accountEmail: accountRow.email,
			accountName: accountRow.name,
		});
	},

	async reconfigure(c, connectionId, params, userId) {
		await getOwnedConnection(c, Number(connectionId), userId);

		const provider = normalizeText(params?.provider).toLowerCase();
		const protocol = normalizeText(params?.protocol).toLowerCase();
		const authType = normalizeText(params?.authType).toLowerCase();
		if (!canUseMailConnection({ provider, protocol, authType })) {
			throw new BizError(t('mailConnectionCombinationUnsupported'), 400);
		}

		const values = {
			provider,
			protocol,
			authType,
			updateTime: new Date().toISOString(),
		};
		if (Object.prototype.hasOwnProperty.call(params || {}, 'label')) {
			values.label = normalizeText(params.label).slice(0, 80);
		}
		if (Object.prototype.hasOwnProperty.call(params || {}, 'settings')) {
			if (!params.settings || typeof params.settings !== 'object' || Array.isArray(params.settings)) {
				throw new BizError(t('mailConnectionSettingsInvalid'), 400);
			}
			values.settings = JSON.stringify(params.settings);
		}

		await orm(c).update(mailConnection).set(values)
			.where(eq(mailConnection.connectionId, Number(connectionId)))
			.run();

		return getOwnedConnection(c, Number(connectionId), userId);
	},

	async upsertCredential(c, connectionId, params, userId) {
		const row = await getOwnedConnection(c, Number(connectionId), userId);
		const credentialType = normalizeText(params?.credentialType || row.authType).toLowerCase();
		const definition = getMailProviderDefinition(row.provider);

		if (!definition || !definition.authTypes.includes(credentialType) || credentialType !== row.authType) {
			throw new BizError(t('mailConnectionCombinationUnsupported'), 400);
		}

		const secret = typeof params?.secret === 'string' ? params.secret : '';
		if (!secret) {
			throw new BizError(t('mailCredentialRequired'), 400);
		}

		const existing = await orm(c)
			.select()
			.from(mailCredential)
			.where(and(
				eq(mailCredential.connectionId, Number(connectionId)),
				eq(mailCredential.credentialType, credentialType),
			))
			.get();

		const encryptionKey = getEncryptionKey(c);
		const encryptedSecret = await cryptoUtils.encryptSecret(encryptionKey, secret);
		const hasClientSecret = Object.prototype.hasOwnProperty.call(params || {}, 'clientSecret');
		const clientSecret = typeof params?.clientSecret === 'string' ? params.clientSecret : '';
		const encryptedClientSecret = clientSecret
			? await cryptoUtils.encryptSecret(encryptionKey, clientSecret)
			: null;
		const hasAccessToken = Object.prototype.hasOwnProperty.call(params || {}, 'accessToken');
		const accessToken = typeof params?.accessToken === 'string' ? params.accessToken : '';
		const encryptedAccessToken = accessToken
			? await cryptoUtils.encryptSecret(encryptionKey, accessToken)
			: null;
		const hasAccessTokenExpiresAt = Object.prototype.hasOwnProperty.call(params || {}, 'accessTokenExpiresAt');
		const hasScopes = Object.prototype.hasOwnProperty.call(params || {}, 'scopes');
		const hasMetadata = Object.prototype.hasOwnProperty.call(params || {}, 'metadata');
		const scopes = normalizeScopes(params?.scopes);
		const metadata = normalizeMetadata(params?.metadata);
		const credentialValues = {
			connectionId: Number(connectionId),
			credentialType,
			clientId: Object.prototype.hasOwnProperty.call(params || {}, 'clientId')
				? normalizeText(params?.clientId)
				: existing?.clientId || '',
			clientSecretCiphertext: hasClientSecret
				? encryptedClientSecret?.ciphertext || ''
				: existing?.clientSecretCiphertext || '',
			clientSecretIv: hasClientSecret
				? encryptedClientSecret?.iv || ''
				: existing?.clientSecretIv || '',
			tokenEndpoint: Object.prototype.hasOwnProperty.call(params || {}, 'tokenEndpoint')
				? normalizeText(params?.tokenEndpoint)
				: existing?.tokenEndpoint || '',
			secretCiphertext: encryptedSecret.ciphertext,
			secretIv: encryptedSecret.iv,
			accessTokenCiphertext: hasAccessToken
				? encryptedAccessToken?.ciphertext || ''
				: existing?.accessTokenCiphertext || '',
			accessTokenIv: hasAccessToken
				? encryptedAccessToken?.iv || ''
				: existing?.accessTokenIv || '',
			accessTokenExpiresAt: hasAccessTokenExpiresAt
				? normalizeText(params?.accessTokenExpiresAt) || null
				: existing?.accessTokenExpiresAt || null,
			scopes: hasScopes ? JSON.stringify(scopes) : existing?.scopes || '[]',
			metadata: hasMetadata ? JSON.stringify(metadata) : existing?.metadata || '{}',
			updateTime: new Date().toISOString(),
		};

		let credentialRow;
		if (existing) {
			credentialRow = await orm(c)
				.update(mailCredential)
				.set(credentialValues)
				.where(eq(mailCredential.credentialId, existing.credentialId))
				.returning()
				.get();
		} else {
			credentialRow = await orm(c).insert(mailCredential).values(credentialValues).returning().get();
		}

		await orm(c).update(mailConnection).set({
			status: 'ready',
			lastSyncStatus: '',
			lastSyncError: '',
			updateTime: new Date().toISOString(),
		}).where(eq(mailConnection.connectionId, Number(connectionId))).run();

		return credentialView(credentialRow);
	},

	async deleteCredential(c, connectionId, userId) {
		await getOwnedConnection(c, Number(connectionId), userId);
		await orm(c).delete(mailCredential)
			.where(eq(mailCredential.connectionId, Number(connectionId)))
			.run();
		await orm(c).update(mailConnection).set({
			status: 'pending',
			updateTime: new Date().toISOString(),
		}).where(eq(mailConnection.connectionId, Number(connectionId))).run();
	},

	async getCredentialSecret(c, connectionId, credentialType) {
		const credential = await this.getCredential(c, connectionId, credentialType);
		return credential.secret;
	},

	async getCredential(c, connectionId, credentialType) {
		const row = await orm(c).select().from(mailCredential).where(and(
			eq(mailCredential.connectionId, Number(connectionId)),
			eq(mailCredential.credentialType, credentialType),
		)).get();

		if (!row) {
			throw new BizError(t('mailCredentialRequired'), 404);
		}

		const encryptionKey = getEncryptionKey(c);
		const secret = await cryptoUtils.decryptSecret(
			encryptionKey,
			row.secretCiphertext,
			row.secretIv,
		);
		const accessToken = row.accessTokenCiphertext
			? await cryptoUtils.decryptSecret(
				encryptionKey,
				row.accessTokenCiphertext,
				row.accessTokenIv,
			)
			: '';
		const clientSecret = row.clientSecretCiphertext
			? await cryptoUtils.decryptSecret(
				encryptionKey,
				row.clientSecretCiphertext,
				row.clientSecretIv,
			)
			: '';

		return {
			...row,
			secret,
			accessToken,
			clientSecret,
		};
	},

	async saveAccessToken(c, connectionId, credentialType, accessToken, accessTokenExpiresAt, refreshToken = '') {
		const row = await orm(c).select().from(mailCredential).where(and(
			eq(mailCredential.connectionId, Number(connectionId)),
			eq(mailCredential.credentialType, credentialType),
		)).get();

		if (!row) {
			throw new BizError(t('mailCredentialRequired'), 404);
		}

		const encryptionKey = getEncryptionKey(c);
		const encryptedAccessToken = await cryptoUtils.encryptSecret(encryptionKey, accessToken);
		const updateValues = {
			accessTokenCiphertext: encryptedAccessToken.ciphertext,
			accessTokenIv: encryptedAccessToken.iv,
			accessTokenExpiresAt: accessTokenExpiresAt || null,
			updateTime: new Date().toISOString(),
		};

		if (refreshToken) {
			const encryptedRefreshToken = await cryptoUtils.encryptSecret(encryptionKey, refreshToken);
			updateValues.secretCiphertext = encryptedRefreshToken.ciphertext;
			updateValues.secretIv = encryptedRefreshToken.iv;
		}

		await orm(c).update(mailCredential).set(updateValues)
			.where(eq(mailCredential.credentialId, row.credentialId))
			.run();
	},

	async updateSyncState(c, connectionId, status, error = '') {
		await orm(c).update(mailConnection).set({
			lastSyncAt: new Date().toISOString(),
			lastSyncStatus: status,
			lastSyncError: error,
			updateTime: new Date().toISOString(),
		}).where(eq(mailConnection.connectionId, Number(connectionId))).run();
	},

	getConnection,
	getOwnedConnection,
};

export default mailConnectionService;
