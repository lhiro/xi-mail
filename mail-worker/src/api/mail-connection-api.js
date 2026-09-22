import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import mailConnectionService from '../service/mail-connection-service';
import mailSyncService from '../service/mail-sync-service';
import verifyAdminToken from '../security/admin-token';
import mailImportService from '../service/mail-import-service';
import mailOAuthService from '../service/mail-oauth-service';

app.get('/mail/providers', async (c) => {
	return c.json(result.ok(mailConnectionService.listProviders()));
});

app.get('/mail/connections', async (c) => {
	const list = await mailConnectionService.list(c, userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.post('/mail/connections', async (c) => {
	const connection = await mailConnectionService.create(
		c,
		await c.req.json(),
		userContext.getUserId(c),
	);
	return c.json(result.ok(connection));
});

app.put('/mail/connections/:connectionId', async (c) => {
	const connection = await mailConnectionService.reconfigure(
		c,
		c.req.param('connectionId'),
		await c.req.json(),
		userContext.getUserId(c),
	);
	return c.json(result.ok(connection));
});

app.put('/mail/connections/:connectionId/credential', async (c) => {
	const credential = await mailConnectionService.upsertCredential(
		c,
		c.req.param('connectionId'),
		await c.req.json(),
		userContext.getUserId(c),
	);
	return c.json(result.ok(credential));
});

app.delete('/mail/connections/:connectionId/credential', async (c) => {
	await mailConnectionService.deleteCredential(
		c,
		c.req.param('connectionId'),
		userContext.getUserId(c),
	);
	return c.json(result.ok());
});

app.post('/mail/connections/:connectionId/sync', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const syncResult = await mailSyncService.syncConnection(
		c,
		c.req.param('connectionId'),
		body,
	);
	return c.json(result.ok(syncResult));
});

app.post('/mail/connections/:connectionId/oauth/authorize', async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const authorize = await mailOAuthService.createAuthorizeUrl(
		c,
		c.req.param('connectionId'),
		body,
		userContext.getUserId(c),
	);
	return c.json(result.ok(authorize));
});

app.get('/oauth/mail/callback', async (c) => {
	const callbackResult = await mailOAuthService.handleCallback(c);
	return c.html(mailOAuthService.oauthSuccessHtml(callbackResult.returnUrl));
});

app.post('/admin/mail/connections/import', async (c) => {
	await verifyAdminToken(c);
	const summary = await mailImportService.importBatch(c, await c.req.json());
	return c.json(result.ok(summary));
});
