function splitSetCookieHeader(headerValue) {
	if (!headerValue) {
		return [];
	}

	const parts = [];
	let start = 0;
	let inExpires = false;
	for (let index = 0; index < headerValue.length; index += 1) {
		const chunk = headerValue.slice(Math.max(0, index - 8), index + 1).toLowerCase();
		if (chunk.endsWith('expires=')) {
			inExpires = true;
		}
		if (inExpires && headerValue[index] === ';') {
			inExpires = false;
		}
		if (!inExpires && headerValue[index] === ',' && /\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=/.test(headerValue.slice(index + 1, index + 80))) {
			parts.push(headerValue.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(headerValue.slice(start).trim());
	return parts.filter(Boolean);
}

function domainMatches(host, domain) {
	const normalizedHost = String(host || '').toLowerCase();
	const normalizedDomain = String(domain || '').replace(/^\./, '').toLowerCase();
	return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function pathMatches(pathname, cookiePath) {
	return String(pathname || '/').startsWith(cookiePath || '/');
}

export class CookieJar {
	constructor() {
		this.cookies = new Map();
	}

	setFromHeaders(headers, url) {
		const setCookieHeaders = typeof headers.getSetCookie === 'function'
			? headers.getSetCookie()
			: splitSetCookieHeader(headers.get('set-cookie'));
		for (const setCookie of setCookieHeaders) {
			this.setCookie(setCookie, url);
		}
	}

	setCookie(setCookie, url) {
		const currentUrl = new URL(url);
		const segments = String(setCookie || '').split(';').map(segment => segment.trim()).filter(Boolean);
		if (!segments.length || !segments[0].includes('=')) {
			return;
		}

		const [name, ...valueParts] = segments[0].split('=');
		const cookie = {
			name,
			value: valueParts.join('='),
			domain: currentUrl.hostname,
			path: '/',
			secure: false,
			expires: 0,
		};

		for (const segment of segments.slice(1)) {
			const [rawKey, ...rawValue] = segment.split('=');
			const key = rawKey.toLowerCase();
			const value = rawValue.join('=');
			if (key === 'domain' && value) {
				cookie.domain = value.replace(/^\./, '').toLowerCase();
			} else if (key === 'path' && value) {
				cookie.path = value;
			} else if (key === 'secure') {
				cookie.secure = true;
			} else if (key === 'expires') {
				const expires = Date.parse(value);
				cookie.expires = Number.isFinite(expires) ? expires : 0;
			} else if (key === 'max-age') {
				const maxAge = Number(value);
				cookie.expires = Number.isFinite(maxAge) ? Date.now() + maxAge * 1000 : 0;
			}
		}

		const mapKey = `${cookie.domain}\t${cookie.path}\t${cookie.name}`;
		if (cookie.expires && cookie.expires <= Date.now()) {
			this.cookies.delete(mapKey);
			return;
		}
		this.cookies.set(mapKey, cookie);
	}

	getCookieHeader(url) {
		const currentUrl = new URL(url);
		const values = [];
		for (const [key, cookie] of this.cookies.entries()) {
			if (cookie.expires && cookie.expires <= Date.now()) {
				this.cookies.delete(key);
				continue;
			}
			if (cookie.secure && currentUrl.protocol !== 'https:') {
				continue;
			}
			if (!domainMatches(currentUrl.hostname, cookie.domain) || !pathMatches(currentUrl.pathname, cookie.path)) {
				continue;
			}
			values.push(`${cookie.name}=${cookie.value}`);
		}
		return values.join('; ');
	}
}

function quoteCurlConfig(value) {
	return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function proxyFetch(url, options, { proxyUrl, timeoutMs }) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'xi-mail-curl-'));
	const configPath = path.join(directory, 'curl.conf');
	const headersPath = path.join(directory, 'headers.txt');
	const bodyPath = path.join(directory, 'body.bin');
	const requestPath = path.join(directory, 'request.bin');
	const requestBody = options.body === undefined || options.body === null
		? null
		: Buffer.from(String(options.body));
	if (requestBody) {
		await writeFile(requestPath, requestBody, { mode: 0o600 });
	}
	const config = [
		'silent',
		'show-error',
		`max-time = ${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
		`proxy = ${quoteCurlConfig(proxyUrl)}`,
		`request = ${quoteCurlConfig(options.method || 'GET')}`,
		`dump-header = ${quoteCurlConfig(headersPath)}`,
		`output = ${quoteCurlConfig(bodyPath)}`,
		...Array.from(new Headers(options.headers || {}).entries()).map(([name, value]) => (
			`header = ${quoteCurlConfig(`${name}: ${value}`)}`
		)),
		...(requestBody ? [`data-binary = ${quoteCurlConfig(`@${requestPath}`)}`] : []),
	].join('\n');
	await writeFile(configPath, config, { mode: 0o600 });
	try {
		const output = await new Promise((resolve, reject) => {
			const child = spawn('curl', [
				'--config', configPath,
				'--write-out', '\n%{http_code}\n%{url_effective}',
				String(url),
			], { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', chunk => { stdout += chunk.toString(); });
			child.stderr.on('data', chunk => { stderr += chunk.toString(); });
			child.on('error', reject);
			child.on('close', code => code === 0
				? resolve(stdout)
				: reject(new Error(`proxy fetch failed (${code}): ${stderr.slice(0, 180)}`)));
		});
		const lines = String(output).trim().split(/\r?\n/);
		const effectiveUrl = lines.pop() || String(url);
		const status = Number(lines.pop() || 0);
		const rawHeaders = await readFile(headersPath, 'utf8').catch(() => '');
		const headerBlocks = rawHeaders.trim().split(/\r?\n\r?\n/).filter(Boolean);
		const headerLines = (headerBlocks.at(-1) || '').split(/\r?\n/).slice(1);
		const headers = new Headers();
		for (const line of headerLines) {
			const separator = line.indexOf(':');
			if (separator > 0) {
				headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
			}
		}
		const body = await readFile(bodyPath).catch(() => Buffer.alloc(0));
		const response = new Response(body, { status, headers });
		Object.defineProperty(response, 'url', { value: effectiveUrl });
		return response;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export function createCookieFetch({ timeoutMs = 30000, proxyUrl = '' } = {}) {
	const jar = new CookieJar();
	return {
		jar,
		async fetch(url, options = {}) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const headers = new Headers(options.headers || {});
				const cookieHeader = jar.getCookieHeader(url);
				if (cookieHeader && !headers.has('cookie')) {
					headers.set('cookie', cookieHeader);
				}
				const requestOptions = { redirect: 'manual', ...options, headers, signal: controller.signal };
				const response = proxyUrl
					? await proxyFetch(url, requestOptions, { proxyUrl, timeoutMs })
					: await globalThis.fetch(url, requestOptions);
				jar.setFromHeaders(response.headers, url);
				return response;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
