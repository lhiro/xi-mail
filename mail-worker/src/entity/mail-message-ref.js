import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mailMessageRef = sqliteTable('mail_message_ref', {
	messageRefId: integer('message_ref_id').primaryKey({ autoIncrement: true }),
	emailId: integer('email_id').notNull(),
	connectionId: integer('connection_id').notNull(),
	remoteId: text('remote_id').notNull(),
	folder: text('folder').notNull().default('inbox'),
	remoteTag: text('remote_tag').notNull().default(''),
	remoteReceivedAt: text('remote_received_at'),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
	emailUnique: uniqueIndex('idx_mail_message_ref_email').on(table.emailId),
	remoteUnique: uniqueIndex('idx_mail_message_ref_remote')
		.on(table.connectionId, table.remoteId, table.folder),
	connectionIndex: index('idx_mail_message_ref_connection').on(table.connectionId),
}));

export default mailMessageRef;
