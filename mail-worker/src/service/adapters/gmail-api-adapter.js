const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function mailProviderError(message, status = 502, code = 'GMAIL_API_ERROR') {
	const error = new Error(message);
	error.name = 'MailProviderError';
	error.status = status;
	error.code = code;
	return error;
}

function decodeBase64Url(value) {
	if (!value) {
		return '';
	}

	const normalized = String(value)
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(String(value).length / 4) * 4, '=');
	const binary = atob(normalized);
	const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function headerValue(headers, name) {
	const target = String(name).toLowerCase();
	return (headers || []).find(header => String(header?.name || '').toLowerCase() === target)?.value || '';
}

function parseAddress(value) {
	const source = String(value || '').trim();
	if (!source) {
		return null;
	}

	const match = source.match(/^(?:"?([^"]*)"?\s*)?<([^>]+)>$/);
	const address = (match ? match[2] : source).trim();
	if (!address || !address.includes('@')) {
		return null;
	}

	return {
		emailAddress: {
			address,
			name: (match?.[1] || '').trim(),
		},
	};
}

function parseAddressList(value) {
	return String(value || '')
		.split(',')
		.map(parseAddress)
		.filter(Boolean);
}

function collectBody(payload) {
	let text = '';
	let html = '';

	function visit(part) {
		if (!part) {
			return;
		}

		const mimeType = String(part.mimeType || '').toLowerCase();
		const content = decodeBase64Url(part.body?.data);
		if (mimeType === 'text/plain' && !text) {
			text = content;
		}
		if (mimeType === 'text/html' && !html) {
			html = content;
		}

		for (const child of part.parts || []) {
			visit(child);
		}
	}

	visit(payload);
	return { text, html };
}

function stripHtml(value) {
	return String(value || '')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeMessage(message) {
	const payload = message?.payload || {};
	const headers = payload.headers || [];
	const bodyParts = collectBody(payload);
	const bodyText = bodyParts.text || stripHtml(bodyParts.html);
	const bodyContent = bodyParts.html || bodyText;
	const internalDate = Number(message?.internalDate);
	const receivedDateTime = Number.isFinite(internalDate) && internalDate > 0
		? new Date(internalDate).toISOString()
		: new Date().toISOString();

	return {
		id: String(message?.id || ''),
		changeKey: String(message?.historyId || ''),
		subject: headerValue(headers, 'Subject'),
		from: parseAddress(headerValue(headers, 'From')),
		toRecipients: parseAddressList(headerValue(headers, 'To')),
		ccRecipients: parseAddressList(headerValue(headers, 'Cc')),
		bccRecipients: parseAddressList(headerValue(headers, 'Bcc')),
		internetMessageId: headerValue(headers, 'Message-ID'),
		receivedDateTime,
		isRead: !(message?.labelIds || []).includes('UNREAD'),
		bodyPreview: bodyText.slice(0, 500),
		body: {
			content: bodyContent,
			contentType: bodyParts.html ? 'html' : 'text',
		},
	};
}

async function readJson(response) {
	try {
		return await response.json();
	} catch (error) {
		throw mailProviderError(`Gmail returned an invalid response (${response.status})`, response.status);
	}
}

async function requestJson(url, accessToken) {
	if (!accessToken) {
		throw mailProviderError('Gmail access token is missing', 401, 'GMAIL_ACCESS_TOKEN_MISSING');
	}

	const response = await fetch(url, {
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${accessToken}`,
		},
	});
	const data = await readJson(response);
	if (!response.ok) {
		const message = data?.error?.message || `Gmail request failed (${response.status})`;
		throw mailProviderError(message, response.status, data?.error?.status || 'GMAIL_API_ERROR');
	}
	return data;
}

const gmailApiAdapter = {
	async refreshAccessToken({
		clientId,
		clientSecret,
		refreshToken,
		tokenEndpoint = GMAIL_TOKEN_ENDPOINT,
	}) {
		if (!refreshToken) {
			throw mailProviderError('Gmail refresh token is missing', 401, 'GMAIL_REFRESH_TOKEN_MISSING');
		}

		const params = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		});
		if (clientId) {
			params.set('client_id', clientId);
		}
		if (clientSecret) {
			params.set('client_secret', clientSecret);
		}

		const response = await fetch(tokenEndpoint || GMAIL_TOKEN_ENDPOINT, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: params.toString(),
		});
		const data = await readJson(response);
		if (!response.ok || !data.access_token) {
			const message = data?.error_description || data?.error || `Gmail token refresh failed (${response.status})`;
			throw mailProviderError(message, response.status, data?.error || 'GMAIL_TOKEN_REFRESH_FAILED');
		}

		const expiresIn = Math.max(Number(data.expires_in) || 3600, 60);
		return {
			accessToken: data.access_token,
			expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
			refreshToken: data.refresh_token || '',
		};
	},

	async listMessages({ accessToken, folder = 'inbox', top = 20, pageToken = '' }) {
		const url = new URL(`${GMAIL_API_BASE}/messages`);
		const labelByFolder = {
			inbox: 'INBOX',
			sent: 'SENT',
			trash: 'TRASH',
			spam: 'SPAM',
			drafts: 'DRAFT',
		};
		const labelId = labelByFolder[String(folder).toLowerCase()];
		const maxResults = Math.min(Math.max(Number(top) || 20, 1), 20);
		url.searchParams.set('maxResults', String(maxResults));
		if (labelId) {
			url.searchParams.set('labelIds', labelId);
		}
		if (pageToken) {
			url.searchParams.set('pageToken', pageToken);
		}

		const page = await requestJson(url.toString(), accessToken);
		const messages = [];
		for (const item of page.messages || []) {
			const detailUrl = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(item.id)}`);
			detailUrl.searchParams.set('format', 'full');
			const detail = await requestJson(detailUrl.toString(), accessToken);
			messages.push(normalizeMessage(detail));
		}

		return {
			value: messages,
			total: Number.isFinite(Number(page.resultSizeEstimate))
				? Number(page.resultSizeEstimate)
				: null,
			nextPageToken: page.nextPageToken || '',
		};
	},
};

export { GMAIL_TOKEN_ENDPOINT };
export default gmailApiAdapter;
