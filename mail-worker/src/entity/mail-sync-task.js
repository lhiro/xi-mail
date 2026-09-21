import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const mailSyncTask = sqliteTable('mail_sync_task', {
	taskId: integer('task_id').primaryKey({ autoIncrement: true }),
	connectionId: integer('connection_id').notNull(),
	taskType: text('task_type').notNull(),
	status: text('status').notNull().default('pending'),
	idempotencyKey: text('idempotency_key').notNull(),
	payload: text('payload').notNull().default('{}'),
	attemptCount: integer('attempt_count').notNull().default(0),
	lockedUntil: text('locked_until'),
	lastError: text('last_error').notNull().default(''),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
	idempotencyUnique: uniqueIndex('idx_mail_sync_task_idempotency').on(table.idempotencyKey),
	statusIndex: index('idx_mail_sync_task_status').on(table.status, table.lockedUntil),
	connectionIndex: index('idx_mail_sync_task_connection').on(table.connectionId),
}));

export default mailSyncTask;
