export const mailProvider = Object.freeze({
	OUTLOOK: 'outlook',
	GMAIL: 'gmail',
	IMAP: 'imap',
	CUSTOM: 'custom',
});

export const mailProtocol = Object.freeze({
	GRAPH: 'graph',
	GMAIL_API: 'gmail_api',
	IMAP: 'imap',
	SMTP: 'smtp',
});

export const mailAuthType = Object.freeze({
	OAUTH2: 'oauth2',
	APP_PASSWORD: 'app_password',
	PASSWORD: 'password',
});

export const mailConnectionStatus = Object.freeze({
	PENDING: 'pending',
	READY: 'ready',
	ERROR: 'error',
	DISABLED: 'disabled',
});

export const mailCapability = Object.freeze({
	RECEIVE: 'receive',
	SEND: 'send',
	SYNC: 'sync',
	READ: 'read',
	DELETE: 'delete',
	ATTACHMENTS: 'attachments',
	BATCH_IMPORT: 'batch_import',
});

const providerDefinitions = Object.freeze({
	[mailProvider.OUTLOOK]: {
		id: mailProvider.OUTLOOK,
		name: 'Outlook / Microsoft 365',
		protocols: [mailProtocol.GRAPH, mailProtocol.IMAP, mailProtocol.SMTP],
		authTypes: [mailAuthType.OAUTH2, mailAuthType.PASSWORD],
		capabilities: [
			mailCapability.RECEIVE,
			mailCapability.SEND,
			mailCapability.SYNC,
			mailCapability.READ,
			mailCapability.DELETE,
			mailCapability.ATTACHMENTS,
			mailCapability.BATCH_IMPORT,
		],
	},
	[mailProvider.GMAIL]: {
		id: mailProvider.GMAIL,
		name: 'Gmail',
		protocols: [mailProtocol.GMAIL_API, mailProtocol.IMAP, mailProtocol.SMTP],
		authTypes: [mailAuthType.OAUTH2, mailAuthType.APP_PASSWORD],
		capabilities: [
			mailCapability.RECEIVE,
			mailCapability.SEND,
			mailCapability.SYNC,
			mailCapability.READ,
			mailCapability.DELETE,
			mailCapability.ATTACHMENTS,
			mailCapability.BATCH_IMPORT,
		],
	},
	[mailProvider.IMAP]: {
		id: mailProvider.IMAP,
		name: 'Generic IMAP / SMTP',
		protocols: [mailProtocol.IMAP, mailProtocol.SMTP],
		authTypes: [mailAuthType.APP_PASSWORD, mailAuthType.PASSWORD],
		capabilities: [
			mailCapability.RECEIVE,
			mailCapability.SEND,
			mailCapability.SYNC,
			mailCapability.READ,
			mailCapability.DELETE,
			mailCapability.ATTACHMENTS,
		],
	},
	[mailProvider.CUSTOM]: {
		id: mailProvider.CUSTOM,
		name: 'Custom mail provider',
		protocols: [mailProtocol.IMAP, mailProtocol.SMTP],
		authTypes: [mailAuthType.APP_PASSWORD, mailAuthType.PASSWORD],
		capabilities: [
			mailCapability.RECEIVE,
			mailCapability.SEND,
			mailCapability.SYNC,
			mailCapability.READ,
			mailCapability.DELETE,
			mailCapability.ATTACHMENTS,
		],
	},
});

export function getMailProviderDefinition(provider) {
	return providerDefinitions[provider] || null;
}

export function listMailProviderDefinitions() {
	return Object.values(providerDefinitions);
}

export function canUseMailConnection({ provider, protocol, authType }) {
	const definition = getMailProviderDefinition(provider);
	if (!definition) {
		return false;
	}

	return definition.protocols.includes(protocol) && definition.authTypes.includes(authType);
}

export default {
	mailProvider,
	mailProtocol,
	mailAuthType,
	mailConnectionStatus,
	mailCapability,
	getMailProviderDefinition,
	listMailProviderDefinitions,
	canUseMailConnection,
};
