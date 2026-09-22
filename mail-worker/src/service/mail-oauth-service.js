import BizError from '../error/biz-error';
import { mailAuthType, mailProvider, mailProtocol } from '../const/mail-provider';
import { t } from '../i18n/i18n';
import mailConnectionService from './mail-connection-service';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STATE_TTL_SECONDS = 10 * 60;

const OUTLOOK_DEFAULT_SCOPES = [
	'offline_access',
	'https://graph.microsoft.com/User.Read',
	'https://graph.microsoft.com/Mail.Read',
	'https://graph.microsoft.com/Mail.ReadWrite',
];
const GMAIL_DEFAULT_SCOPES = [
	'https://www.googleapis.com/auth/gmail.readonly',
];

function base64Url(bytes) {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
	const normalized = String(value || '')
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
	const binary = atob(normalized);
	return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function randomVerifier() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function sha256Base64Url(value) {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
	return base64Url(new Uint8Array(digest));
}

function envValue(c, names) {
	for (const name of names) {
		const value = c.env?.[name];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return '';
}

function normalizeList(value, fallback = []) {
	if (Array.isArray(value)) {
		return value.map(item => String(item || '').trim()).filter(Boolean);
	}
	if (typeof value === 'string' && value.trim()) {
		return value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
	}
	return fallback;
}

function parseJson(value, fallback = {}) {
	try {
		return value ? JSON.parse(value) : fallback;
	} catch (error) {
		return fallback;
	}
}

function escapeHtml(value = '') {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function safeReturnUrl(value = '') {
	const raw = String(value || '').trim();
	if (!raw) {
		return '';
	}
	if (raw.startsWith('/') && !raw.startsWith('//')) {
		return raw;
	}
	try {
		const url = new URL(raw);
		return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
	} catch (error) {
		return '';
	}
}

function defaultRedirectUri(c) {
	const configured = envValue(c, ['MAIL_OAUTH_REDIRECT_URI', 'mail_oauth_redirect_uri']);
	if (configured) {
		return configured;
	}
	const url = new URL(c.req.url);
	return `${url.origin}/api/oauth/mail/callback`;
}

function stateSecret(c) {
	const secret = envValue(c, ['MAIL_OAUTH_STATE_SECRET', 'mail_oauth_state_secret', 'jwt_secret']);
	if (!secret) {
		throw new BizError(t('mailOAuthConfigMissing'), 503);
	}
	return secret;
}

async function deriveStateKey(secret) {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
	return crypto.subtle.importKey(
		'raw',
		digest,
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt'],
	);
}

async function signState(c, state) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await deriveStateKey(stateSecret(c));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		encoder.encode(JSON.stringify(state)),
	);
	return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function verifyState(c, token) {
	const [version, ivValue, ciphertextValue, extra] = String(token || '').split('.');
	if (version !== 'v1' || !ivValue || !ciphertextValue || extra) {
		throw new BizError(t('mailOAuthStateInvalid'), 400);
	}
	let state;
	try {
		const key = await deriveStateKey(stateSecret(c));
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: base64UrlToBytes(ivValue) },
			key,
			base64UrlToBytes(ciphertextValue),
		);
		state = JSON.parse(decoder.decode(plaintext));
	} catch (error) {
		throw new BizError(t('mailOAuthStateInvalid'), 400);
	}
	const issuedAt = Number(state?.iat || 0);
	if (!issuedAt || Date.now() - issuedAt > STATE_TTL_SECONDS * 1000) {
		throw new BizError(t('mailOAuthStateInvalid'), 400);
	}
	return state;
}

function providerConfig(c, connection, params = {}) {
	const settings = typeof connection.settings === 'string'
		? parseJson(connection.settings || '{}')
		: connection.settings || {};
	const merged = { ...settings?.oauth, ...params };

	if (connection.provider === mailProvider.OUTLOOK && connection.protocol === mailProtocol.GRAPH) {
		const tenant = String(merged.tenant || envValue(c, ['OUTLOOK_OAUTH_TENANT', 'MICROSOFT_OAUTH_TENANT']) || 'common').trim();
		const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
		return {
			provider: mailProvider.OUTLOOK,
			clientId: String(merged.clientId || envValue(c, ['OUTLOOK_OAUTH_CLIENT_ID', 'MICROSOFT_CLIENT_ID', 'OAUTH_CLIENT_ID']) || '').trim(),
			clientSecret: String(merged.clientSecret || envValue(c, ['OUTLOOK_OAUTH_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET', 'OAUTH_CLIENT_SECRET']) || '').trim(),
			authorizeEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
			tokenEndpoint,
			scopes: normalizeList(merged.scopes, OUTLOOK_DEFAULT_SCOPES),
			metadata: { tenant },
		};
	}

	if (connection.provider === mailProvider.GMAIL && connection.protocol === mailProtocol.GMAIL_API) {
		return {
			provider: mailProvider.GMAIL,
			clientId: String(merged.clientId || envValue(c, ['GMAIL_OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID']) || '').trim(),
			clientSecret: String(merged.clientSecret || envValue(c, ['GMAIL_OAUTH_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET']) || '').trim(),
			authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
			tokenEndpoint: 'https://oauth2.googleapis.com/token',
			scopes: normalizeList(merged.scopes, GMAIL_DEFAULT_SCOPES),
			metadata: {},
		};
	}

	throw new BizError(t('mailOAuthProviderUnsupported'), 400);
}

function ensureOAuthConnection(connection) {
	if (connection.authType !== mailAuthType.OAUTH2) {
		throw new BizError(t('mailConnectionCombinationUnsupported'), 400);
	}
}

async function exchangeToken(config, { code, redirectUri, codeVerifier }) {
	const params = new URLSearchParams({
		client_id: config.clientId,
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier,
	});
	if (config.provider === mailProvider.OUTLOOK) {
		params.set('scope', config.scopes.join(' '));
	}
	if (config.clientSecret) {
		params.set('client_secret', config.clientSecret);
	}

	const response = await fetch(config.tokenEndpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		},
		body: params.toString(),
	});
	let data = {};
	try {
		data = await response.json();
	} catch (error) {
		data = {};
	}
	if (!response.ok || !data.access_token) {
		const message = data.error_description || data.error || `token exchange failed (${response.status})`;
		throw new BizError(`${t('mailOAuthTokenExchangeFailed')}: ${message}`, response.status || 502);
	}
	return data;
}

function oauthSuccessHtml(returnUrl = '') {
	const escapedReturnUrl = escapeHtml(returnUrl);
	return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(t('mailOAuthSuccess'))}</title><body><p>${escapeHtml(t('mailOAuthSuccess'))}</p>${escapedReturnUrl ? `<p><a href="${escapedReturnUrl}">${escapeHtml(t('mailOAuthReturn'))}</a></p>` : ''}<script>try{window.opener&&window.opener.postMessage({type:'xi-mail-oauth',status:'success'},'*')}catch(e){};setTimeout(()=>window.close(),800);</script></body>`;
}

const mailOAuthService = {
	async createAuthorizeUrl(c, connectionId, params = {}, userId) {
		const connection = await mailConnectionService.getOwnedConnection(c, Number(connectionId), userId);
		ensureOAuthConnection(connection);
		const config = providerConfig(c, connection, params);
		if (!config.clientId) {
			throw new BizError(t('mailOAuthConfigMissing'), 503);
		}

		const redirectUri = String(params.redirectUri || defaultRedirectUri(c)).trim();
		const codeVerifier = randomVerifier();
		const state = await signState(c, {
			connectionId: connection.connectionId,
			userId,
			provider: connection.provider,
			protocol: connection.protocol,
			redirectUri,
			codeVerifier,
			returnUrl: safeReturnUrl(params.returnUrl),
			iat: Date.now(),
		});
		const authorizeUrl = new URL(config.authorizeEndpoint);
		authorizeUrl.searchParams.set('client_id', config.clientId);
		authorizeUrl.searchParams.set('response_type', 'code');
		authorizeUrl.searchParams.set('redirect_uri', redirectUri);
		authorizeUrl.searchParams.set('scope', config.scopes.join(' '));
		authorizeUrl.searchParams.set('state', state);
		authorizeUrl.searchParams.set('code_challenge', await sha256Base64Url(codeVerifier));
		authorizeUrl.searchParams.set('code_challenge_method', 'S256');
		if (config.provider === mailProvider.OUTLOOK) {
			authorizeUrl.searchParams.set('response_mode', 'query');
			authorizeUrl.searchParams.set('prompt', String(params.prompt || 'select_account'));
		} else if (config.provider === mailProvider.GMAIL) {
			authorizeUrl.searchParams.set('access_type', 'offline');
			authorizeUrl.searchParams.set('include_granted_scopes', 'true');
			authorizeUrl.searchParams.set('prompt', String(params.prompt || 'consent'));
		}

		return {
			provider: connection.provider,
			connectionId: connection.connectionId,
			redirectUri,
			authorizeUrl: authorizeUrl.toString(),
			expiresIn: STATE_TTL_SECONDS,
		};
	},

	async handleCallback(c) {
		const code = c.req.query('code') || '';
		const error = c.req.query('error') || '';
		const errorDescription = c.req.query('error_description') || '';
		const state = await verifyState(c, c.req.query('state') || '');
		if (error) {
			throw new BizError(`${error}: ${errorDescription}`, 400);
		}
		if (!code) {
			throw new BizError(t('mailOAuthStateInvalid'), 400);
		}

		const connection = await mailConnectionService.getConnection(c, Number(state.connectionId));
		if (Number(connection.userId) !== Number(state.userId)
			|| connection.provider !== state.provider
			|| connection.protocol !== state.protocol) {
			throw new BizError(t('mailOAuthStateInvalid'), 400);
		}
		ensureOAuthConnection(connection);

		const config = providerConfig(c, connection);
		if (!config.clientId) {
			throw new BizError(t('mailOAuthConfigMissing'), 503);
		}
		const token = await exchangeToken(config, {
			code,
			redirectUri: state.redirectUri,
			codeVerifier: state.codeVerifier,
		});
		if (!token.refresh_token) {
			throw new BizError(t('mailOAuthRefreshTokenMissing'), 400);
		}

		const expiresIn = Math.max(Number(token.expires_in || 3600) - 60, 60);
		await mailConnectionService.upsertCredential(c, connection.connectionId, {
			credentialType: mailAuthType.OAUTH2,
			secret: token.refresh_token,
			accessToken: token.access_token,
			accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
			clientId: config.clientId,
			clientSecret: config.clientSecret,
			tokenEndpoint: config.tokenEndpoint,
			scopes: normalizeList(token.scope, config.scopes),
			metadata: {
				provider: config.provider,
				authorizedAt: new Date().toISOString(),
				...config.metadata,
			},
		}, state.userId);

		return {
			connectionId: connection.connectionId,
			provider: connection.provider,
			returnUrl: state.returnUrl || '',
		};
	},

	oauthSuccessHtml,
};

export default mailOAuthService;
