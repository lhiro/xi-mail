import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mailConnection = sqliteTable('mail_connection', {
	connectionId: integer('connection_id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull(),
	provider: text('provider').notNull(),
	protocol: text('protocol').notNull(),
	authType: text('auth_type').notNull(),
	label: text('label').notNull().default(''),
	status: text('status').notNull().default('pending'),
	settings: text('settings').notNull().default('{}'),
	lastSyncAt: text('last_sync_at'),
	lastSyncStatus: text('last_sync_status').notNull().default(''),
	lastSyncError: text('last_sync_error').notNull().default(''),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
	accountUnique: uniqueIndex('idx_mail_connection_account').on(table.accountId),
	statusIndex: index('idx_mail_connection_status').on(table.status),
}));

export default mailConnection;
