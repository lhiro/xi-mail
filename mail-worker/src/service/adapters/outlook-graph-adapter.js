const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const DEFAULT_GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

class MailProviderError extends Error {
	constructor(message, status = 502, details = '') {
		super(message);
		this.name = 'MailProviderError';
		this.status = status;
		this.details = details;
	}
}

async function readResponseDetails(response) {
	try {
		const body = await response.json();
		return body?.error_description || body?.error?.message || body?.error || response.statusText;
	} catch (e) {
		return response.statusText;
	}
}

function normalizeFolder(folder) {
	const folderMap = {
		inbox: 'inbox',
		junkemail: 'junkemail',
		deleteditems: 'deleteditems',
		trash: 'deleteditems',
	};
	return folderMap[String(folder || 'inbox').toLowerCase()] || 'inbox';
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken, tokenEndpoint, scopes }) {
	const endpoint = tokenEndpoint || DEFAULT_TOKEN_ENDPOINT;
	const body = new URLSearchParams({
		client_id: clientId,
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	});
	const normalizedScopes = Array.isArray(scopes) ? scopes.filter(Boolean) : [];
	if (normalizedScopes.length > 0) {
		body.set('scope', normalizedScopes.join(' '));
	} else {
		body.set('scope', DEFAULT_GRAPH_SCOPE);
	}
	if (clientSecret) {
		body.set('client_secret', clientSecret);
	}

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		},
		body: body.toString(),
	});

	if (!response.ok) {
		throw new MailProviderError(
			'Outlook token refresh failed',
			response.status === 400 || response.status === 401 ? 401 : 502,
			await readResponseDetails(response),
		);
	}

	const data = await response.json();
	if (!data.access_token) {
		throw new MailProviderError('Outlook token response did not contain an access token');
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || '',
		expiresAt: new Date(Date.now() + Math.max(Number(data.expires_in || 3600) - 60, 60) * 1000).toISOString(),
	};
}

async function graphRequest(url, accessToken) {
	const response = await fetch(url, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: 'application/json',
			ConsistencyLevel: 'eventual',
			Prefer: 'outlook.body-content-type="text"',
		},
	});

	if (!response.ok) {
		throw new MailProviderError(
			'Outlook Graph request failed',
			response.status === 401 ? 401 : 502,
			await readResponseDetails(response),
		);
	}

	return response.json();
}

async function listMessages({ accessToken, folder = 'inbox', top = 30, nextLink = '' }) {
	const url = nextLink || (() => {
		const endpoint = new URL(
			`${GRAPH_BASE_URL}/me/mailFolders/${encodeURIComponent(normalizeFolder(folder))}/messages`,
		);
		endpoint.searchParams.set('$top', String(Math.min(Math.max(Number(top) || 30, 1), 50)));
		endpoint.searchParams.set('$count', 'true');
		endpoint.searchParams.set(
			'$select',
			'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,hasAttachments,body,bodyPreview,internetMessageId',
		);
		endpoint.searchParams.set('$orderby', 'receivedDateTime desc');
		return endpoint.toString();
	})();

	const page = await graphRequest(url, accessToken);
	return {
		...page,
		total: Number.isFinite(Number(page?.['@odata.count']))
			? Number(page['@odata.count'])
			: null,
	};
}

export {
	DEFAULT_TOKEN_ENDPOINT,
	MailProviderError,
	refreshAccessToken,
	listMessages,
};

export default {
	DEFAULT_TOKEN_ENDPOINT,
	MailProviderError,
	refreshAccessToken,
	listMessages,
};
