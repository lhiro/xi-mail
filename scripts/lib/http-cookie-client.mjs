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

export function createCookieFetch({ timeoutMs = 30000 } = {}) {
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
				const response = await globalThis.fetch(url, {
					redirect: 'manual',
					...options,
					headers,
					signal: controller.signal,
				});
				jar.setFromHeaders(response.headers, url);
				return response;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
