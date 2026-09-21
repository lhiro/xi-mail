const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value) {
	const binary = atob(value);
	return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function deriveAesKey(secret) {
	if (!secret || typeof secret !== 'string') {
		throw new Error('mail credential encryption key is not configured');
	}

	const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
	return crypto.subtle.importKey(
		'raw',
		keyMaterial,
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt'],
	);
}

const saltHashUtils = {

	generateSalt(length = 16) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array));
	},


	async hashPassword(password) {
		const salt = this.generateSalt();
		const hash = await this.genHashPassword(password, salt);
		return { salt, hash };
	},

	async genHashPassword(password, salt) {
		const data = encoder.encode(salt + password);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return btoa(String.fromCharCode(...hashArray));
	},

	async verifyPassword(inputPassword, salt, storedHash) {
		const hash = await this.genHashPassword(inputPassword, salt);
		return hash === storedHash;
	},

	genRandomPwd(length = 8) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < length; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	},

	async encryptSecret(secret, plaintext) {
		if (typeof plaintext !== 'string' || plaintext.length === 0) {
			throw new Error('secret cannot be empty');
		}

		const key = await deriveAesKey(secret);
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			key,
			encoder.encode(plaintext),
		);

		return {
			ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
			iv: bytesToBase64(iv),
		};
	},

	async decryptSecret(secret, ciphertext, iv) {
		if (!ciphertext || !iv) {
			throw new Error('encrypted secret is incomplete');
		}

		const key = await deriveAesKey(secret);
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: base64ToBytes(iv) },
			key,
			base64ToBytes(ciphertext),
		);

		return decoder.decode(plaintext);
	},
};

export default saltHashUtils;
