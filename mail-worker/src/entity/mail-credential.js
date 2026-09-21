import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mailCredential = sqliteTable('mail_credential', {
	credentialId: integer('credential_id').primaryKey({ autoIncrement: true }),
	connectionId: integer('connection_id').notNull(),
	credentialType: text('credential_type').notNull(),
	clientId: text('client_id').notNull().default(''),
	clientSecretCiphertext: text('client_secret_ciphertext').notNull().default(''),
	clientSecretIv: text('client_secret_iv').notNull().default(''),
	tokenEndpoint: text('token_endpoint').notNull().default(''),
	secretCiphertext: text('secret_ciphertext').notNull().default(''),
	secretIv: text('secret_iv').notNull().default(''),
	accessTokenCiphertext: text('access_token_ciphertext').notNull().default(''),
	accessTokenIv: text('access_token_iv').notNull().default(''),
	accessTokenExpiresAt: text('access_token_expires_at'),
	scopes: text('scopes').notNull().default('[]'),
	metadata: text('metadata').notNull().default('{}'),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
	connectionTypeUnique: uniqueIndex('idx_mail_credential_connection_type')
		.on(table.connectionId, table.credentialType),
	connectionIndex: index('idx_mail_credential_connection').on(table.connectionId),
}));

export default mailCredential;
