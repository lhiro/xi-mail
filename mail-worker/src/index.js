import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from "./service/oauth-service";
import mailSyncService from './service/mail-sync-service';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await kvObjService.toObjResp( { env }, url.pathname.substring(1));
		 }

		if (env.assets) return env.assets.fetch(req);
		return new Response('Xi-Mail API is running. Frontend is deployed separately.', {
			status: 200, headers: { 'Content-Type': 'text/plain' }
		});
	},
	email: email,
	async scheduled(controller, env, ctx) {
		const runtime = { env };
		await verifyRecordService.clearRecord(runtime);
		await userService.resetDaySendCount(runtime);
		await emailService.completeReceiveAll(runtime);
		await oauthService.clearNoBindOathUser(runtime);
		await userService.autoBanInactiveUsers(runtime);
		await mailSyncService.enqueueReadyConnections(runtime);
	},
	async queue(batch, env, ctx) {
		const runtime = { env };
		for (const message of batch.messages) {
			try {
				const payload = typeof message.body === 'string'
					? JSON.parse(message.body)
					: message.body;
				const syncResult = await mailSyncService.syncConnection(
					runtime,
					payload.connectionId,
					payload,
				);
				if (syncResult?.skipped && syncResult.reason === 'in_flight') {
					message.retry();
					continue;
				}
				message.ack();
			} catch (error) {
				message.retry();
			}
		}
	},
};
