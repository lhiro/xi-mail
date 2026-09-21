import { createCookieFetch } from './http-cookie-client.mjs';
import { maskEmail } from './env.mjs';

export const OUTLOOK_OAUTH_DEFAULTS = Object.freeze({
	clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
	redirectUri: 'http://localhost:8080',
	authority: 'consumers',
	scopes: [
		'offline_access',
		'https://graph.microsoft.com/Mail.Read',
		'https://graph.microsoft.com/Mail.ReadWrite',
		'https://graph.microsoft.com/User.Read',
	],
	timeoutMs: 30000,
	userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
});

function decodeHtml(value = '') {
	return String(value)
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function stripText(html = '') {
	return String(html)
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function titleOf(html = '') {
	return decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
}

function extractInputs(html = '') {
	const out = {};
	for (const tag of String(html).match(/<input\b[^>]*>/gi) || []) {
		const name = /\bname=["']([^"']*)["']/i.exec(tag)?.[1]
			|| /\bname=([^\s>]+)/i.exec(tag)?.[1]
			|| '';
		if (!name) {
			continue;
		}
		const value = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1]
			|| /\bvalue=([^\s>]+)/i.exec(tag)?.[1]
			|| '';
		out[decodeHtml(name)] = decodeHtml(value);
	}
	return out;
}

function firstForm(html = '') {
	const match = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(String(html));
	if (!match) {
		return null;
	}
	const attrs = match[1] || '';
	const body = match[2] || '';
	return {
		action: decodeHtml(/\baction=["']([^"']+)["']/i.exec(attrs)?.[1]
			|| /\baction=([^\s>]+)/i.exec(attrs)?.[1]
			|| ''),
		method: (/\bmethod=["']([^"']+)["']/i.exec(attrs)?.[1] || 'post').toLowerCase(),
		body,
		inputs: extractInputs(body),
	};
}

function absoluteUrl(action, currentUrl) {
	return action ? new URL(action, currentUrl).toString() : currentUrl;
}

function isRedirectStatus(status) {
	return [301, 302, 303, 307, 308].includes(status);
}

function redact(value = '') {
	return String(value)
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, item => maskEmail(item))
		.replace(/(code=)[^&\s]+/gi, '$1***')
		.replace(/(iOttText=)[^&\s]+/gi, '$1***')
		.slice(0, 1600);
}

function extractConfig(html = '') {
	const index = String(html).indexOf('var t0=');
	if (index < 0) {
		return null;
	}
	const start = String(html).indexOf('{', index);
	if (start < 0) {
		return null;
	}

	let depth = 0;
	let inString = false;
	let escaped = false;
	let quote = '';
	let end = -1;
	for (let pointer = start; pointer < html.length; pointer += 1) {
		const char = html[pointer];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === quote) {
				inString = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			quote = char;
			continue;
		}
		if (char === '{') {
			depth += 1;
		} else if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				end = pointer + 1;
				break;
			}
		}
	}
	if (end < 0) {
		return null;
	}

	try {
		return JSON.parse(html.slice(start, end));
	} catch {
		return null;
	}
}

function classifyPage({ text = '', url = '', redirectUri }) {
	const pageText = stripText(text);
	if (url.startsWith(redirectUri) && url.includes('code=')) {
		return { status: 'auth_code', code: new URL(url).searchParams.get('code') };
	}
	if (url.startsWith(redirectUri) && url.includes('error=')) {
		const params = new URL(url).searchParams;
		return { status: 'oauth_error', detail: params.get('error_description') || params.get('error') || '' };
	}
	if (/Enter the code we sent|Enter your security code|iOttText|Verification code|安全代码/i.test(text) || /proofs\/Verify/i.test(url)) {
		return { status: 'proof_verify_code' };
	}
	if (/Let's protect your account|Add an email address|EmailAddress|proofs\/Add/i.test(text) || /proofs\/Add/i.test(url)) {
		return { status: 'proof_add_email' };
	}
	if (/Help protect your account|Add email so you can safely sign in|interrupt\/credentialaction/i.test(text) || /interrupt\/credentialaction/i.test(url)) {
		return { status: 'credential_action_recovery_email' };
	}
	if (/Help us protect your account|rawProofList|Proofs\/SendOtt|identity\/confirm/i.test(text) || /identity\/confirm/i.test(url)) {
		return { status: 'identity_confirm' };
	}
	if (/incorrect|wrong password|doesn.t exist|locked|blocked|suspended|密码不正确|账号不存在/i.test(pageText)) {
		return { status: 'login_failed' };
	}
	if (/verify your identity|two-step|authenticator/i.test(pageText)) {
		return { status: 'needs_interactive_verification' };
	}
	return { status: 'continue' };
}

function authUrl(config) {
	return `https://login.microsoftonline.com/${config.authority}/oauth2/v2.0/authorize?${new URLSearchParams({
		client_id: config.clientId,
		response_type: 'code',
		redirect_uri: config.redirectUri,
		scope: config.scopes.join(' '),
		response_mode: 'query',
	}).toString()}`;
}

export function outlookTokenRecord({ accountEmail, refreshToken, config, recoveryEmail }) {
	return {
		email: accountEmail.toLowerCase(),
		clientId: config.clientId,
		refreshToken,
		scopes: config.scopes,
		tokenEndpoint: `https://login.microsoftonline.com/${config.authority}/oauth2/v2.0/token`,
		createdAt: new Date().toISOString(),
		recoveryEmail,
	};
}

export class OutlookProtocolOAuthClient {
	constructor(options = {}) {
		const { trace, log, ...configOptions } = options;
		const definedConfigOptions = Object.fromEntries(
			Object.entries(configOptions).filter(([, value]) => value !== undefined),
		);
		this.config = {
			...OUTLOOK_OAUTH_DEFAULTS,
			...definedConfigOptions,
			scopes: definedConfigOptions.scopes || OUTLOOK_OAUTH_DEFAULTS.scopes,
		};
		this.trace = trace || null;
		this.log = log || (() => {});
	}

	async authorize(account, options = {}) {
		const recoveryEmail = options.recoveryEmail || '';
		const codeProvider = options.codeProvider;
		if (!codeProvider) {
			throw new Error('missing codeProvider');
		}
		const client = createCookieFetch({ timeoutMs: this.config.timeoutMs });
		const state = {
			account,
			recoveryEmail,
			codeProvider,
			fetch: client.fetch,
			traceContext: options.traceContext || {},
		};

		let step = await this.loginStart(state);
		if (step.status && !step.res) {
			return step;
		}
		return this.finishOauth(state, step);
	}

	async traceStep(state, row) {
		if (!this.trace) {
			return;
		}
		await this.trace({
			...state.traceContext,
			...row,
			url: row.url ? redact(row.url) : row.url,
			action: row.action ? redact(row.action) : row.action,
			text: row.text ? redact(stripText(row.text).slice(0, 1200)) : row.text,
		});
	}

	async fetchText(state, url, options = {}) {
		const response = await state.fetch(url, {
			...options,
			headers: {
				'user-agent': this.config.userAgent,
				...(options.headers || {}),
			},
		});
		return { res: response, text: await response.text(), url: response.url || url };
	}

	async postForm(state, url, data, headers = {}, referer = '') {
		return this.fetchText(state, url, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				...(referer ? { origin: new URL(url).origin, referer } : {}),
				...headers,
			},
			body: new URLSearchParams(data).toString(),
		});
	}

	async postJson(state, url, data, pageConfig = {}) {
		const headers = {
			'content-type': 'application/json; charset=UTF-8',
			accept: 'application/json',
			canary: pageConfig.apiCanary || '',
			uaid: pageConfig.uaid || pageConfig.clientTelemetry?.uaid || '',
			hpgid: String(pageConfig.hpgid || ''),
			scid: String(pageConfig.scid || ''),
			uiflvr: String(pageConfig.uiflvr || ''),
			'x-requested-with': 'XMLHttpRequest',
		};
		if (pageConfig.clientTelemetry?.tcxt) {
			headers.tcxt = pageConfig.clientTelemetry.tcxt;
		}
		const response = await state.fetch(url, {
			method: 'POST',
			headers: {
				'user-agent': this.config.userAgent,
				...headers,
			},
			body: JSON.stringify(data),
		});
		const text = await response.text();
		let json = {};
		try {
			json = JSON.parse(text);
		} catch {
			json = {};
		}
		return { res: response, text, json, url: response.url || url };
	}

	async followRedirects(state, step) {
		let current = step;
		for (let index = 0; index < 10 && isRedirectStatus(current.res.status); index += 1) {
			const location = current.res.headers.get('location');
			if (!location) {
				break;
			}
			const nextUrl = new URL(location, current.url).toString();
			if (nextUrl.startsWith(this.config.redirectUri)) {
				return { res: new Response('', { status: 200 }), text: '', url: nextUrl };
			}
			current = await this.fetchText(state, nextUrl, { method: 'GET' });
		}
		return current;
	}

	async loginStart(state) {
		let step = await this.fetchText(state, authUrl(this.config));
		step = await this.followRedirects(state, step);

		const text = step.text || '';
		const ppft = /name=["']PPFT["'][^>]*value=["']([^"']+)/i.exec(text)?.[1]
			|| /sFTTag.*?value=\\?"([^"\\]+)/is.exec(text)?.[1]
			|| '';
		const postUrl = /"urlPost"\s*:\s*"([^"]+)/.exec(text)?.[1]?.replace(/\\u0026/g, '&')
			|| 'https://login.live.com/ppsecure/post.srf';
		const ctx = /"sCtx"\s*:\s*"([^"]+)"/.exec(text)?.[1] || '';
		if (!ppft) {
			return { status: 'no_ppft', detail: redact(text.slice(0, 500)) };
		}

		step = await this.postForm(state, postUrl, {
			login: state.account.email,
			loginfmt: state.account.email,
			passwd: state.account.password,
			PPFT: ppft,
			ctx,
			type: '11',
			LoginOptions: '3',
			i13: '0',
			CookieDisclosure: '0',
			IsFidoSupported: '0',
			isSignupPost: '0',
			i19: '16393',
		});
		return this.followRedirects(state, step);
	}

	async handleAddProof(state, step) {
		await this.traceStep(state, { phase: 'add_enter', url: step.url, title: titleOf(step.text), text: step.text });
		let form = firstForm(step.text);
		if (form?.action && /proofs\/Add/i.test(form.action) && !('EmailAddress' in form.inputs)) {
			step = await this.postForm(state, absoluteUrl(form.action, step.url), form.inputs, {}, step.url);
			step = await this.followRedirects(state, step);
			await this.traceStep(state, { phase: 'add_rendered', url: step.url, title: titleOf(step.text), text: step.text });
			form = firstForm(step.text);
		}
		if (!form?.action || !/proofs\/Add/i.test(form.action) || !('EmailAddress' in form.inputs)) {
			return { status: 'add_form_not_found', url: redact(step.url), detail: redact(titleOf(step.text) || stripText(step.text).slice(0, 300)) };
		}

		const afterMs = Date.now();
		step = await this.postForm(state, absoluteUrl(form.action, step.url), {
			...form.inputs,
			action: form.inputs.action || 'AddProof',
			iProofOptions: 'Email',
			EmailAddress: state.recoveryEmail,
			PhoneNumber: '',
			PhoneCountryISO: '',
		}, {}, step.url);
		step = await this.followRedirects(state, step);
		await this.traceStep(state, { phase: 'add_submitted', url: step.url, title: titleOf(step.text), text: step.text });
		const postForm = firstForm(step.text);
		if (postForm?.inputs && 'EmailAddress' in postForm.inputs) {
			return {
				status: 'add_proof_not_accepted',
				url: redact(step.url),
				detail: redact(titleOf(step.text) || stripText(step.text).slice(0, 300)),
			};
		}
		return this.handleVerifyForm(state, step, afterMs);
	}

	async handleVerifyForm(state, step, afterMs = Date.now()) {
		const form = firstForm(step.text);
		await this.traceStep(state, {
			phase: 'verify_enter',
			url: step.url,
			title: titleOf(step.text),
			keys: Object.keys(form?.inputs || {}),
			text: step.text,
		});
		if (!form?.action || !('iOttText' in form.inputs)) {
			return { status: 'verify_form_not_found', url: redact(step.url), detail: redact(titleOf(step.text) || stripText(step.text).slice(0, 300)) };
		}

		const code = await state.codeProvider({
			accountEmail: state.account.email,
			recoveryEmail: state.recoveryEmail,
			afterMs,
			purpose: 'proof_verify',
		});
		step = await this.postForm(state, absoluteUrl(form.action, step.url), {
			...form.inputs,
			iOttText: code,
			action: form.inputs.action || 'VerifyProof',
		}, {}, step.url);
		step = await this.followRedirects(state, step);
		await this.traceStep(state, { phase: 'verify_submitted', url: step.url, title: titleOf(step.text), text: step.text });
		const postClass = classifyPage({ text: step.text || '', url: step.url || '', redirectUri: this.config.redirectUri });
		if (postClass.status === 'proof_verify_code') {
			return { status: 'verify_code_failed', url: redact(step.url), detail: redact(titleOf(step.text) || stripText(step.text).slice(0, 240)) };
		}
		return this.finishOauth(state, step);
	}

	async handleIdentityConfirm(state, step) {
		let form = firstForm(step.text || '');
		if (form?.action && /identity\/confirm/i.test(form.action) && !extractConfig(step.text || '')) {
			step = await this.postForm(state, absoluteUrl(form.action, step.url), form.inputs, {}, step.url);
			step = await this.followRedirects(state, step);
		}
		const pageConfig = extractConfig(step.text);
		await this.traceStep(state, {
			phase: 'identity_enter',
			url: step.url,
			title: titleOf(step.text),
			hasConfig: Boolean(pageConfig),
			text: step.text,
		});

		const data = pageConfig?.WLXAccount?.confirmIdentity?.viewContext?.data || {};
		let proofList = [];
		try {
			proofList = JSON.parse(data.rawProofList || '[]');
		} catch {
			proofList = [];
		}
		const proof = proofList.find(item => item.type === 'Email' && item.epid) || proofList.find(item => item.epid);
		if (!pageConfig || !proof) {
			return { status: 'identity_parse_failed', url: redact(step.url), detail: 'missing cfg/proof' };
		}

		const sendUrl = pageConfig.WLXAccount?.urls?.dataRequest?.sendOtt?.url || 'https://account.live.com/API/Proofs/SendOtt';
		const verifyUrl = pageConfig.WLXAccount?.urls?.dataRequest?.verifyCode?.url || 'https://account.live.com/API/Proofs/VerifyCode';
		const afterMs = Date.now();
		const send = await this.postJson(state, sendUrl, {
			token: data.token || '',
			purpose: 'UnfamiliarLocationHard',
			epid: proof.epid,
			autoVerification: false,
			autoVerificationFailed: false,
			confirmProof: state.recoveryEmail,
		}, pageConfig);
		await this.traceStep(state, { phase: 'identity_send_ott', url: sendUrl, status: send.res.status, text: send.text });
		if (!send.res.ok || send.json?.error) {
			return { status: 'send_ott_failed', detail: redact(JSON.stringify(send.json || {}).slice(0, 300)) };
		}
		if (send.json?.apiCanary) {
			pageConfig.apiCanary = send.json.apiCanary;
		}
		if (send.json?.telemetryContext) {
			pageConfig.clientTelemetry = pageConfig.clientTelemetry || {};
			pageConfig.clientTelemetry.tcxt = send.json.telemetryContext;
		}

		const code = await state.codeProvider({
			accountEmail: state.account.email,
			recoveryEmail: state.recoveryEmail,
			afterMs,
			purpose: 'identity_confirm',
		});
		const verify = await this.postJson(state, verifyUrl, {
			code,
			action: 'IptVerify',
			purpose: 'UnfamiliarLocationHard',
			epid: proof.epid,
			confirmProof: state.recoveryEmail,
		}, pageConfig);
		await this.traceStep(state, { phase: 'identity_verify_code', url: verifyUrl, status: verify.res.status, text: verify.text });
		if (!verify.res.ok || verify.json?.error) {
			return { status: 'verify_code_failed', detail: redact(JSON.stringify(verify.json || {}).slice(0, 300)) };
		}

		const returnUrl = pageConfig.WLXAccount?.confirmIdentity?.options?.viewDefs?.return?.url;
		if (!returnUrl) {
			return { status: 'identity_return_url_missing' };
		}
		step = await this.fetchText(state, returnUrl);
		step = await this.followRedirects(state, step);
		return this.finishOauth(state, step);
	}

	async exchangeCode(state, code) {
		const response = await this.postForm(state, `https://login.microsoftonline.com/${this.config.authority}/oauth2/v2.0/token`, {
			client_id: this.config.clientId,
			grant_type: 'authorization_code',
			code,
			redirect_uri: this.config.redirectUri,
			scope: this.config.scopes.join(' '),
		}, { accept: 'application/json' });
		let data = {};
		try {
			data = JSON.parse(response.text);
		} catch {
			data = {};
		}
		if (!response.res.ok || !data.refresh_token) {
			throw new Error(`token_exchange_failed:${data.error_description || data.error || response.res.status}`);
		}
		return data;
	}

	async graphMe(accessToken) {
		const response = await globalThis.fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
			headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(`graph_me_failed:${data.error?.message || response.status}`);
		}
		return data;
	}

	async finishOauth(state, initialStep) {
		let step = initialStep;
		for (let index = 0; index < 40; index += 1) {
			step = await this.followRedirects(state, step);
			const pageClass = classifyPage({ text: step.text || '', url: step.url || '', redirectUri: this.config.redirectUri });
			const form = firstForm(step.text || '');
			await this.traceStep(state, {
				phase: 'finish',
				iter: index,
				status: pageClass.status,
				url: step.url,
				formAction: form?.action || '',
				keys: Object.keys(form?.inputs || {}),
				text: step.text,
			});

			if (pageClass.status === 'auth_code') {
				const token = await this.exchangeCode(state, pageClass.code);
				const me = await this.graphMe(token.access_token);
				return {
					status: 'success',
					refreshToken: token.refresh_token,
					accessTokenExpiresIn: token.expires_in,
					graphMail: me.mail || me.userPrincipalName || '',
					tokenRecord: outlookTokenRecord({
						accountEmail: state.account.email,
						refreshToken: token.refresh_token,
						config: this.config,
						recoveryEmail: state.recoveryEmail,
					}),
				};
			}
			if (pageClass.status === 'oauth_error') {
				return pageClass;
			}
			if (pageClass.status === 'proof_verify_code') {
				return this.handleVerifyForm(state, step, Date.now() - 30000);
			}
			if (pageClass.status === 'proof_add_email') {
				return this.handleAddProof(state, step);
			}
			if (pageClass.status === 'credential_action_recovery_email') {
				return { ...pageClass, url: redact(step.url), detail: redact(titleOf(step.text) || stripText(step.text).slice(0, 300)) };
			}
			if (pageClass.status === 'identity_confirm') {
				return this.handleIdentityConfirm(state, step);
			}

			const text = step.text || '';
			const needsConsent = (/Consent\/Update|Consent\/update|oauth20_authorize/i.test(step.url || '')
				&& /permission|consent|access|Allow|Accept|Yes|approve|授权|同意/i.test(text))
				|| /ServerData\s*=/.test(text);
			if (needsConsent) {
				const serverDataMatch = /ServerData\s*=\s*(\{.*?\});/s.exec(text);
				if (serverDataMatch) {
					const serverData = JSON.parse(serverDataMatch[1]);
					step = await this.postForm(state, step.url, {
						ucaction: 'Yes',
						client_id: serverData.sClientId || '',
						scope: serverData.sRawInputScopes || '',
						cscope: serverData.sRawInputGrantedScopes || '',
						canary: serverData.sCanary || '',
					}, {}, step.url);
					continue;
				}
				if (form?.action) {
					step = await this.postForm(state, absoluteUrl(form.action, step.url), {
						...form.inputs,
						ucaction: 'Yes',
						ucaccept: 'Yes',
						consent: 'accept',
						accept: 'Yes',
					}, {}, step.url);
					continue;
				}
			}

			if (form?.action) {
				const action = absoluteUrl(form.action, step.url);
				const data = { ...form.inputs };
				if (/consent|permission|authorize|oauth/i.test(action)
					|| /consent|permission|authorize|oauth/i.test(step.url || '')
					|| /permission|access|Allow|Accept|Yes|同意|授权/i.test(text)) {
					data.ucaccept = 'Yes';
					data.ucaction = data.ucaction || 'Yes';
					data.consent = data.consent || 'accept';
					data.accept = data.accept || 'Yes';
				}
				step = await this.postForm(state, action, data, {}, step.url);
				continue;
			}

			if (pageClass.status !== 'continue') {
				return { ...pageClass, url: redact(step.url) };
			}
			return { status: 'stuck', url: redact(step.url), detail: redact(titleOf(text) || stripText(text).slice(0, 400)) };
		}
		return { status: 'loop_exceeded', url: redact(step.url) };
	}
}
