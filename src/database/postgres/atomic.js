'use strict';

const context = require('../atomic-context');

module.exports = function (db, pool) {
	const query = pool.query.bind(pool);
	const connect = pool.connect.bind(pool);
	pool.query = function (...args) {
		const state = context.current();
		if (!state) return query(...args);
		if (state.closed) throw new Error('Atomic mutation context is closed');
		return state.client.query(...args);
	};
	pool.connect = function (...args) {
		const state = context.current();
		if (state) {
			// A caller that swallows this refusal must not reach a successful commit,
			// so the transaction is poisoned before the error leaves.
			const err = new Error('Independent connections are forbidden inside an atomic mutation');
			state.failure = err;
			throw err;
		}
		return connect(...args);
	};

	db.atomic = async function (lock, perform) {
		if (context.current()) throw new Error('Nested atomic mutations are forbidden');
		const client = await connect();
		const state = { effects: [], closed: false };
		state.client = {
			query: function (...args) {
				if (state.closed) throw new Error('Atomic mutation context is closed');
				if (typeof args[args.length - 1] === 'function') throw new Error('Atomic queries must return promises');
				const result = client.query(...args);
				if (result && typeof result.catch === 'function') {
					return result.catch((err) => {
						state.failure = err;
						throw err;
					});
				}
				return result;
			},
		};
		let result;
		let committing = false;
		let releaseError;
		try {
			await client.query('BEGIN');
			await client.query("SET LOCAL lock_timeout = '5s'");
			await client.query("SET LOCAL statement_timeout = '30s'");
			await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
			result = await context.run(state, perform);
			if (state.failure) throw state.failure;
			state.closed = true;
			committing = true;
			const committed = await client.query('COMMIT');
			if (committed.command !== 'COMMIT') throw new Error('Atomic mutation did not commit');
		} catch (err) {
			state.closed = true;
			if (committing) {
				err.mutationOutcome = 'unknown';
				releaseError = err;
				state.failure = err;
			} else {
				try { await client.query('ROLLBACK'); } catch (rollbackError) {
					releaseError = rollbackError;
					require('winston').error(rollbackError);
				}
			}
			throw err;
		} finally {
			client.release(releaseError);
		}
		// Effects cannot change the outcome of the committed database transaction.
		await state.effects.reduce((previous, effect) => previous.then(() => effect()).catch((err) => {
			require('winston').error(err);
		}), Promise.resolve());
		return result;
	};
};
