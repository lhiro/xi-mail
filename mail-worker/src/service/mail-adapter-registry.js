import { mailAuthType, mailProvider, mailProtocol } from '../const/mail-provider';
import gmailApiAdapter from './adapters/gmail-api-adapter';
import gmailImapAdapter from './adapters/gmail-imap-adapter';
import outlookGraphAdapter from './adapters/outlook-graph-adapter';

const adapters = new Map([
	[
		`${mailProvider.OUTLOOK}:${mailProtocol.GRAPH}:${mailAuthType.OAUTH2}`,
		outlookGraphAdapter,
	],
	[
		`${mailProvider.GMAIL}:${mailProtocol.GMAIL_API}:${mailAuthType.OAUTH2}`,
		gmailApiAdapter,
	],
	[
		`${mailProvider.GMAIL}:${mailProtocol.IMAP}:${mailAuthType.APP_PASSWORD}`,
		gmailImapAdapter,
	],
]);

export function getMailAdapter({ provider, protocol, authType }) {
	return adapters.get(`${provider}:${protocol}:${authType}`) || null;
}

export default {
	getMailAdapter,
};
