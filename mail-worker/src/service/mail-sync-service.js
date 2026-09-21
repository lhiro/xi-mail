import { and, eq } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { emailConst, isDel } from '../const/entity-const';
import account from '../entity/account';
import email from '../entity/email';
import mailConnection from '../entity/mail-connection';
import mailMessageRef from '../entity/mail-message-ref';
import mailSyncTask from '../entity/mail-sync-task';
import orm from '../entity/orm';
import { t } from '../i18n/i18n';
import mailConnectionService from './mail-connection-service';
import { getMailAdapter } from './mail-adapter-registry';

function parseJson(value, fallback) {
	try {
		return value ? JSON.parse(value) : fallback;
	} catch (e) {
		return fallback;
	}
}

function addressValue(value) {
	return {
		address: value?.emailAddress?.address || '',
		name: value?.emailAddress?.name || '',
	};
}

function addressList(value) {
	return Array.isArray(value)
		? value.map(addressValue).filter(item => item.address)
		: [];
}

function messageBody(message) {
	const content = message?.body?.content || '';
	const preview = message?.bodyPreview || '';
	return {
		content: content || preview,
		text: preview || content,
	};
}

function syncErrorMessage(error) {
	if (error?.name === 'MailProviderError') {
		return error.message;
	}
	if (error?.name === 'BizError') {
		return error.message;
	}
	return 'mail sync failed';
}

async function claimSyncTask(c, connectionId, folder, pageToken = '') {
	const minute = Math.floor(Date.now() / 60000);
	const idempotencyKey = `sync:${connectionId}:${folder}:${pageToken}:${minute}`;
	const existing = await orm(c)
		.select()
		.from(mailSyncTask)
		.where(eq(mailSyncTask.idempotencyKey, idempotencyKey))
		.get();

	if (existing?.status === 'completed') {
		return { task: null, reason: 'completed' };
	}

	const existingLock = Date.parse(existing?.lockedUntil || '');
	if (existing?.status === 'running' && Number.isFinite(existingLock) && existingLock > Date.now()) {
		return { task: null, reason: 'in_flight' };
	}

	if (existing) {
		const task = await orm(c)
			.update(mailSyncTask)
			.set({
				status: 'running',
				attemptCount: (existing.attemptCount || 0) + 1,
				lockedUntil: new Date(Date.now() + 120000).toISOString(),
				lastError: '',
				updateTime: new Date().toISOString(),
			})
			.where(eq(mailSyncTask.taskId, existing.taskId))
			.returning()
			.get();
		return { task: task || null, reason: task ? '' : 'in_flight' };
	}

	const task = await orm(c)
		.insert(mailSyncTask)
		.values({
			connectionId: Number(connectionId),
			taskType: 'receive',
			status: 'running',
			idempotencyKey,
			payload: JSON.stringify({ folder, pageToken }),
			attemptCount: 1,
			lockedUntil: new Date(Date.now() + 120000).toISOString(),
		})
		.onConflictDoNothing({ target: mailSyncTask.idempotencyKey })
		.returning()
		.get();
	return { task: task || null, reason: task ? '' : 'in_flight' };
}

async function completeSyncTask(c, taskId, status, error = '') {
	await orm(c).update(mailSyncTask).set({
		status,
		lastError: error,
		lockedUntil: null,
		updateTime: new Date().toISOString(),
	}).where(eq(mailSyncTask.taskId, taskId)).run();
}

async function accessTokenFor(c, connection, credential, adapter) {
	const expiresAt = Date.parse(credential.accessTokenExpiresAt || '');
	if (credential.accessToken && Number.isFinite(expiresAt) && expiresAt > Date.now() + 60000) {
		return credential.accessToken;
	}

	const token = await adapter.refreshAccessToken({
		clientId: credential.clientId,
		clientSecret: credential.clientSecret,
		refreshToken: credential.secret,
		tokenEndpoint: credential.tokenEndpoint,
		scopes: parseJson(credential.scopes, []),
	});

	await mailConnectionService.saveAccessToken(
		c,
		connection.connectionId,
		connection.authType,
		token.accessToken,
		token.expiresAt,
		token.refreshToken,
	);

	return token.accessToken;
}

async function upsertMessage(c, connection, remoteMessage, folder) {
	const remoteId = String(remoteMessage?.id || '').trim();
	if (!remoteId) {
		return { created: false, updated: false };
	}

	const existingRef = await orm(c).select().from(mailMessageRef).where(and(
		eq(mailMessageRef.connectionId, connection.connectionId),
		eq(mailMessageRef.remoteId, remoteId),
		eq(mailMessageRef.folder, folder),
	)).get();

	const sender = addressValue(remoteMessage.from);
	const recipients = addressList(remoteMessage.toRecipients);
	const cc = addressList(remoteMessage.ccRecipients);
	const bcc = addressList(remoteMessage.bccRecipients);
	const body = messageBody(remoteMessage);
	const receivedAt = remoteMessage.receivedDateTime || new Date().toISOString();
	const values = {
		sendEmail: sender.address || connection.accountEmail,
		name: sender.name || sender.address,
		accountId: connection.accountId,
		userId: connection.userId,
		subject: remoteMessage.subject || '',
		text: body.text,
		content: body.content,
		cc: JSON.stringify(cc),
		bcc: JSON.stringify(bcc),
		recipient: JSON.stringify(recipients),
		toEmail: connection.accountEmail,
		toName: connection.accountName || '',
		inReplyTo: '',
		relation: '',
		messageId: remoteMessage.internetMessageId || remoteId,
		type: emailConst.type.RECEIVE,
		status: emailConst.status.RECEIVE,
		unread: remoteMessage.isRead ? emailConst.unread.READ : emailConst.unread.UNREAD,
		createTime: receivedAt,
		isDel: isDel.NORMAL,
	};

	if (existingRef) {
		await orm(c).update(email).set({
			subject: values.subject,
			text: values.text,
			content: values.content,
			cc: values.cc,
			bcc: values.bcc,
			recipient: values.recipient,
			unread: values.unread,
		}).where(eq(email.emailId, existingRef.emailId)).run();
		return { created: false, updated: true, receivedAt };
	}

	const emailRow = await orm(c).insert(email).values(values).returning().get();
	await orm(c).insert(mailMessageRef).values({
		emailId: emailRow.emailId,
		connectionId: connection.connectionId,
		remoteId,
		folder,
		remoteTag: remoteMessage.changeKey || '',
		remoteReceivedAt: receivedAt,
		updateTime: new Date().toISOString(),
	}).run();

	return { created: true, updated: false, receivedAt };
}

async function enqueueNextPage(c, connectionId, folder, top, page) {
	const queue = c.env.MAIL_SYNC_QUEUE;
	const nextLink = page?.['@odata.nextLink'] || '';
	const nextCursor = page?.nextPageToken || '';
	if (!queue || (!nextLink && !nextCursor)) {
		return false;
	}

	const body = {
		connectionId,
		folder,
		top,
		syncAll: true,
	};
	if (nextLink) {
		body.nextLink = nextLink;
	} else {
		body.pageToken = nextCursor;
	}

	await queue.sendBatch([{
		body,
		contentType: 'json',
	}]);
	return true;
}

const mailSyncService = {
	async syncConnection(c, connectionId, options = {}) {
		const connection = await mailConnectionService.getConnection(c, Number(connectionId));
		const adapter = getMailAdapter(connection);

		if (!adapter) {
			throw new BizError(t('mailAdapterUnsupported'), 400);
		}

		const settings = parseJson(connection.settings, {});
		const folder = String(options.folder || settings.folder || 'inbox').toLowerCase();
		const pageToken = String(options.pageToken || '');
		const pageIdentity = pageToken || String(options.nextLink || '');
		const claim = await claimSyncTask(c, connection.connectionId, folder, pageIdentity);
		if (!claim.task) {
			return { skipped: true, reason: claim.reason };
		}
		const task = claim.task;

		try {
			const credential = await mailConnectionService.getCredential(
				c,
				connection.connectionId,
				connection.authType,
			);
			const accessToken = adapter.requiresAccessToken === false
				? ''
				: await accessTokenFor(c, connection, credential, adapter);
			const page = await adapter.listMessages({
				accessToken,
				username: connection.accountEmail,
				password: credential.secret,
				metadata: parseJson(credential.metadata, {}),
				folder,
				top: options.top || settings.pageSize || 30,
				pageToken,
				nextLink: String(options.nextLink || ''),
			});
			const messages = Array.isArray(page?.value) ? page.value : [];
			let created = 0;
			let updated = 0;
			let latestReceivedAt = '';

			const orderedMessages = [...messages].sort((left, right) => {
				const leftTime = Date.parse(left?.receivedDateTime || '');
				const rightTime = Date.parse(right?.receivedDateTime || '');
				if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
					return leftTime - rightTime;
				}
				if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
					return Number.isFinite(leftTime) ? -1 : 1;
				}
				return String(left?.id || '').localeCompare(String(right?.id || ''));
			});

			for (const remoteMessage of orderedMessages) {
				const result = await upsertMessage(c, connection, remoteMessage, folder);
				if (result.created) created += 1;
				if (result.updated) updated += 1;
				if (result.receivedAt && (!latestReceivedAt || result.receivedAt > latestReceivedAt)) {
					latestReceivedAt = result.receivedAt;
				}
			}

			if (latestReceivedAt) {
				const accountRow = await orm(c)
					.select({ latestEmailTime: account.latestEmailTime })
					.from(account)
					.where(eq(account.accountId, connection.accountId))
					.get();
				const currentLatestTime = Date.parse(accountRow?.latestEmailTime || '');
				const pageLatestTime = Date.parse(latestReceivedAt);
				if (!Number.isFinite(currentLatestTime) || (
					Number.isFinite(pageLatestTime) && pageLatestTime > currentLatestTime
				)) {
					await orm(c).update(account).set({
						latestEmailTime: latestReceivedAt,
					}).where(eq(account.accountId, connection.accountId)).run();
				}
			}

			const top = options.top || settings.pageSize || 30;
			const queuedNext = Boolean(options.syncAll)
				&& await enqueueNextPage(c, connection.connectionId, folder, top, page);
			await mailConnectionService.updateSyncState(c, connection.connectionId, 'success');
			await completeSyncTask(c, task.taskId, 'completed');

			return {
				skipped: false,
				created,
				updated,
				fetched: messages.length,
				total: Number.isFinite(Number(page?.total))
					? Number(page.total)
					: messages.length,
				remoteTotal: Number.isFinite(Number(page?.total))
					? Number(page.total)
					: null,
				nextLink: page?.['@odata.nextLink'] || '',
				nextCursor: page?.nextPageToken || '',
				complete: !(page?.['@odata.nextLink'] || page?.nextPageToken),
				queuedNext,
			};
		} catch (error) {
			const message = syncErrorMessage(error);
			await mailConnectionService.updateSyncState(c, connection.connectionId, 'error', message);
			await completeSyncTask(c, task.taskId, 'failed', message);
			throw new BizError(message, error?.code || error?.status || 502);
		}
	},

	async enqueueReadyConnections(c, options = {}) {
		const queue = c.env.MAIL_SYNC_QUEUE;
		if (!queue) {
			return { enqueued: 0, skipped: 0, queueConfigured: false };
		}

		const rows = await orm(c)
			.select({
				connectionId: mailConnection.connectionId,
				provider: mailConnection.provider,
				protocol: mailConnection.protocol,
				authType: mailConnection.authType,
				settings: mailConnection.settings,
			})
			.from(mailConnection)
			.where(eq(mailConnection.status, 'ready'))
			.all();

		const messages = rows
			.filter(row => getMailAdapter(row))
			.map(row => {
				const settings = parseJson(row.settings, {});
				return {
					body: {
						connectionId: row.connectionId,
						folder: String(options.folder || settings.folder || 'inbox').toLowerCase(),
						top: options.top || settings.pageSize || 20,
					},
					contentType: 'json',
				};
			});

		for (let index = 0; index < messages.length; index += 50) {
			await queue.sendBatch(messages.slice(index, index + 50));
		}

		return {
			enqueued: messages.length,
			skipped: rows.length - messages.length,
			queueConfigured: true,
		};
	},
};

export default mailSyncService;
