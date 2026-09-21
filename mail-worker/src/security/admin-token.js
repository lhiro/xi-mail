import KvConst from '../const/kv-const';
import BizError from '../error/biz-error';

export default async function verifyAdminToken(c) {
	const enabled = await c.env.kv.get(KvConst.GLOBAL_TOKEN_ENABLED);
	if (enabled !== '1') {
		throw new BizError('Global Token 未启用', 403);
	}

	const storedToken = await c.env.kv.get(KvConst.GLOBAL_TOKEN);
	if (!storedToken) {
		throw new BizError('Global Token 未配置', 403);
	}

	const headerToken = c.req.header('x-admin-auth');
	if (!headerToken || headerToken !== storedToken) {
		throw new BizError('Token 验证失败', 401);
	}
}
