import { connect } from 'cloudflare:sockets';
import PostalMime from 'postal-mime';

const DEFAULT_IMAP_HOST = 'imap.gmail.com';
const DEFAULT_IMAP_PORT = 993;
const IMAP_OPERATION_TIMEOUT_MS = 30000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
// Keep each Worker invocation bounded: a single large MIME message can
// consume substantial CPU/memory during PostalMime parsing and D1 upsert.
const MAX_MESSAGES_PER_PAGE = 5;

function mailProviderError(message, status = 502, code = 'IMAP_ERROR') {
	const error = new Error(message);
	error.name = 'MailProviderError';
	error.status = status;
	error.code = code;
	return error;
}

function quote(value) {
	return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function concatBytes(left, right) {
	const output = new Uint8Array(left.length + right.length);
	output.set(left);
	output.set(right, left.length);
	return output;
}

function addressValue(value) {
	if (!value?.address) {
		return null;
	}
	return {
		emailAddress: {
			address: value.address,
			name: value.name || '',
		},
	};
}

function addressList(values) {
	return Array.isArray(values) ? values.map(addressValue).filter(Boolean) : [];
}

function stripHtml(value) {
	return String(value || '')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function pageOffset(pageToken) {
	const value = Number.parseInt(String(pageToken || '0'), 10);
	return Number.isInteger(value) && value > 0 ? value : 0;
}

class ImapSession {
	constructor(host, port) {
		this.host = host;
		this.port = port;
		this.encoder = new TextEncoder();
		this.decoder = new TextDecoder();
		this.buffer = new Uint8Array(0);
		this.sequence = 1;
		this.socket = null;
		this.reader = null;
		this.writer = null;
	}

	async withTimeout(operation, message) {
		let timer;
		try {
			return await Promise.race([
				operation,
				new Promise((resolve, reject) => {
					timer = setTimeout(() => reject(
						mailProviderError(message, 504, 'IMAP_TIMEOUT'),
					), IMAP_OPERATION_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async open() {
		try {
			this.socket = connect(
				{ hostname: this.host, port: this.port },
				{ secureTransport: 'on', allowHalfOpen: false },
			);
			this.reader = this.socket.readable.getReader();
			this.writer = this.socket.writable.getWriter();
			const greeting = this.decoder.decode(await this.withTimeout(
				this.readLine(),
				'IMAP greeting timed out',
			));
			if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting)) {
				throw mailProviderError(`IMAP greeting rejected: ${greeting}`, 502, 'IMAP_GREETING_FAILED');
			}
		} catch (error) {
			await this.close();
			if (error?.name === 'MailProviderError') {
				throw error;
			}
			throw mailProviderError(`Unable to connect to IMAP server ${this.host}:${this.port}`);
		}
	}

	async fill() {
		const chunk = await this.reader.read();
		if (chunk.done) {
			throw mailProviderError('IMAP connection closed unexpectedly', 502, 'IMAP_CONNECTION_CLOSED');
		}
		this.buffer = concatBytes(this.buffer, chunk.value);
	}

	async readLine() {
		while (true) {
			for (let index = 0; index + 1 < this.buffer.length; index += 1) {
				if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
					const line = this.buffer.slice(0, index);
					this.buffer = this.buffer.slice(index + 2);
					return line;
				}
			}
			await this.fill();
		}
	}

	async readBytes(length) {
		while (this.buffer.length < length) {
			await this.fill();
		}
		const bytes = this.buffer.slice(0, length);
		this.buffer = this.buffer.slice(length);
		return bytes;
	}

	async command(command) {
		const tag = `X${String(this.sequence++).padStart(4, '0')}`;
		await this.writer.write(this.encoder.encode(`${tag} ${command}\r\n`));

		return this.withTimeout((async () => {
			const lines = [];
			const literals = [];
			while (true) {
				const line = this.decoder.decode(await this.readLine());
				if (line.startsWith(`${tag} `)) {
					if (!/\sOK\b/i.test(line)) {
						throw mailProviderError(line, 502, 'IMAP_COMMAND_FAILED');
					}
					return { lines, literals, status: line };
				}

				lines.push(line);
				const literalMatch = line.match(/\{(\d+)(?:\+)?\}$/);
				if (literalMatch) {
					literals.push(await this.readBytes(Number(literalMatch[1])));
				}
			}
		})(), `IMAP command timed out: ${command.split(' ')[0]}`);
	}

	async login(username, password) {
		await this.command(`LOGIN ${quote(username)} ${quote(password)}`);
	}

	async select(folder) {
		await this.command(`SELECT ${quote(folder)}`);
	}

	async searchUids(sinceUid = 0) {
		const cursor = Number(sinceUid);
		const command = Number.isInteger(cursor) && cursor > 0
			? `UID SEARCH UID ${cursor + 1}:*`
			: 'UID SEARCH ALL';
		const response = await this.command(command);
		const searchLine = response.lines.find(line => /^\*\s+SEARCH(?:\s|$)/i.test(line)) || '';
		return searchLine
			.replace(/^\*\s+SEARCH\s*/i, '')
			.split(/\s+/)
			.map(value => Number(value))
			.filter(value => Number.isInteger(value) && value > 0);
	}

	async fetchMessage(uid) {
		const response = await this.command(
			`UID FETCH ${uid} (UID BODY.PEEK[]<0.${MAX_MESSAGE_BYTES}> FLAGS INTERNALDATE)`,
		);
		const rawMessage = response.literals[0];
		if (!rawMessage) {
			return null;
		}

		const parsed = await PostalMime.parse(rawMessage);
		const fetchText = response.lines.join('\n');
		const internalDate = fetchText.match(/INTERNALDATE\s+"([^"]+)"/i)?.[1] || '';
		const receivedDate = internalDate ? new Date(internalDate) : new Date(parsed.date || '');
		const receivedDateTime = Number.isNaN(receivedDate.getTime())
			? new Date().toISOString()
			: receivedDate.toISOString();
		const text = parsed.text || stripHtml(parsed.html);
		const content = parsed.html || text;

		return {
			id: String(uid),
			changeKey: '',
			subject: parsed.subject || '',
			from: addressValue(parsed.from),
			toRecipients: addressList(parsed.to),
			ccRecipients: addressList(parsed.cc),
			bccRecipients: addressList(parsed.bcc),
			internetMessageId: parsed.messageId || '',
			receivedDateTime,
			isRead: /\\Seen\b/i.test(fetchText),
			bodyPreview: text.slice(0, 500),
			body: {
				content,
				contentType: parsed.html ? 'html' : 'text',
			},
		};
	}

	async close() {
		try {
			if (this.writer) {
				await this.writer.write(this.encoder.encode(`X${String(this.sequence++).padStart(4, '0')} LOGOUT\r\n`));
			}
		} catch (error) {
			// The connection may already be closed; cleanup below is still required.
		}

		try {
			this.reader?.releaseLock();
		} catch (error) {}
		try {
			this.writer?.releaseLock();
		} catch (error) {}
		try {
			await this.socket?.close();
		} catch (error) {}
		this.reader = null;
		this.writer = null;
		this.socket = null;
	}
}

const gmailImapAdapter = {
	requiresAccessToken: false,
	supportsIncrementalPages: true,

	async listMessages({
		username,
		password,
		metadata = {},
		folder = 'inbox',
		top = 20,
		pageToken = '',
		sinceUid = 0,
	}) {
		if (!username || !password) {
			throw mailProviderError('Gmail IMAP credentials are missing', 401, 'IMAP_CREDENTIAL_MISSING');
		}

		const host = String(metadata.imapHost || DEFAULT_IMAP_HOST);
		const port = Number(metadata.imapPort || DEFAULT_IMAP_PORT);
		const selectedFolder = String(folder).toLowerCase() === 'inbox' ? 'INBOX' : String(folder);
		const limit = Math.min(Math.max(Number(top) || 20, 1), MAX_MESSAGES_PER_PAGE);
		const offset = pageOffset(pageToken);
		const session = new ImapSession(host, port);

		try {
			await session.open();
			await session.login(username, password);
			await session.select(selectedFolder);
			const normalizedSinceUid = Number.isInteger(Number(sinceUid)) && Number(sinceUid) > 0
				? Number(sinceUid)
				: 0;
			const uids = await session.searchUids(normalizedSinceUid);
			const end = Math.max(uids.length - offset, 0);
			const start = Math.max(end - limit, 0);
			const pageUids = uids.slice(start, end).reverse();
			const messages = [];
			for (const uid of pageUids) {
				const message = await session.fetchMessage(uid);
				if (message) {
					messages.push(message);
				}
			}
			const nextOffset = offset + pageUids.length;
			return {
				value: messages,
				total: uids.length,
				nextPageToken: nextOffset < uids.length ? String(nextOffset) : '',
				sinceUid: normalizedSinceUid,
			};
		} finally {
			await session.close();
		}
	},
};

export default gmailImapAdapter;
