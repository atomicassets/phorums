'use strict';

const context = require('../atomic-context');

module.exports = function (module) {
	module.transaction = async function (perform, txClient) {
		const scope = context.current();
		if (scope) {
			if (scope.closed) throw new Error('Atomic mutation context is closed');
			if (txClient && txClient !== scope.client) throw new Error('Atomic mutation client mismatch');
			try {
				return await perform(scope.client);
			} catch (err) {
				scope.failure = err;
				throw err;
			}
		}
		let res;
		if (txClient) {
			await txClient.query(`SAVEPOINT nodebb_subtx`);
			try {
				res = await perform(txClient);
			} catch (err) {
				await txClient.query(`ROLLBACK TO SAVEPOINT nodebb_subtx`);
				throw err;
			}
			await txClient.query(`RELEASE SAVEPOINT nodebb_subtx`);
			return res;
		}
		// see https://node-postgres.com/features/transactions#a-pooled-client-with-async-await
		const client = await module.pool.connect();

		try {
			await client.query('BEGIN');
			res = await perform(client);
			await client.query('COMMIT');
		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
		return res;
	};
};
