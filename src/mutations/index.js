'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const nconf = require('nconf');
const scope = new AsyncLocalStorage();
const evidenceScope = new AsyncLocalStorage();

function required() {
	return nconf.get('mutations:requiredPlugin');
}

function provider() {
	const id = required();
	const plugins = require('../plugins');
	const policy = plugins.libraries[id]?.mutationPolicy;
	if (!id || !plugins.loadedPlugins.some(plugin => plugin.id === id) ||
		!policy || ['authorize', 'validate', 'check', 'receipt'].some(key => typeof policy[key] !== 'function')) {
		throw new Error('Required mutation policy is unavailable');
	}
	if (nconf.get('database') !== 'postgres') throw new Error('Protected mutations require PostgreSQL');
	return policy;
}

exports.check = async function (action, args) {
	if (!required()) return;
	const policy = provider();
	const state = scope.getStore();
	if (!state || state.closed || state.policy !== policy) throw new Error('Verified mutation context is required');
	if (await policy.check(state.ticket, action, args) !== true) throw new Error('Mutation is outside the verified authorization');
};

exports.checkEvidenceWrite = function () {
	const state = evidenceScope.getStore();
	if (!state || state.closed || provider() !== state.policy) throw new Error('Mutation evidence is reserved for core persistence');
};

// Read-side bookkeeping asks this before it writes: true when no policy is
// required, or when an open verified context can authorize the write. A read
// route skips its write instead of failing the page.
exports.available = function () {
	if (!required()) return true;
	try {
		const state = scope.getStore();
		return !!state && !state.closed && state.policy === provider();
	} catch (err) {
		return false;
	}
};

exports.guard = function (object, prefix, names, { unsupported = false } = {}) {
	for (const name of names) {
		const original = object[name];
		if (typeof original !== 'function') throw new Error(`Missing guarded mutation: ${prefix}.${name}`);
		object[name] = async function (...args) {
			if (!required()) return original.apply(this, args);
			const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
			try {
				// A policy sees the same argument list a promise caller sends, so the
				// trailing callback stays out of the authorized arguments.
				await exports.check(`${prefix}.${name}`, callback ? args.slice(0, -1) : args);
				if (unsupported) throw new Error(`Unsupported protected mutation: ${prefix}.${name}`);
			} catch (err) {
				if (callback) return callback(err);
				throw err;
			}
			return original.apply(this, args);
		};
	}
};

exports.run = async function (request, perform) {
	if (scope.getStore()) throw new Error('Nested mutation authorizations are forbidden');
	const policy = provider();
	// Chain/history IO must finish before acquiring database locks.
	const ticket = Object.freeze({ ...await policy.authorize(request) });
	if (!ticket || typeof ticket.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(ticket.nonce)) throw new Error('Invalid verified mutation ticket');
	const db = require('../database');
	if (typeof db.atomic !== 'function') throw new Error('Atomic mutation storage is unavailable');
	return db.atomic('nodebb:protected-mutations:v1', async () => {
		if (provider() !== policy) throw new Error('Required mutation policy changed');
		const key = `mutation:receipt:${ticket.nonce}`;
		if (await db.exists(key)) throw new Error('Mutation authorization was already consumed');
		if (await policy.validate(ticket) !== true) throw new Error('Mutation authorization is stale');
		const state = { policy, ticket, closed: false };
		let result;
		try {
			result = await scope.run(state, perform);
		} finally {
			state.closed = true;
		}
		if (provider() !== policy) throw new Error('Required mutation policy changed');
		const receipt = await policy.receipt(ticket, result);
		if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !Object.keys(receipt).length) throw new Error('Mutation receipt is required');
		const payload = JSON.stringify(receipt);
		if (typeof payload !== 'string') throw new Error('Mutation receipt is required');
		const persisted = JSON.parse(payload);
		if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted) || !Object.keys(persisted).length) throw new Error('Mutation receipt is required');
		if (Buffer.byteLength(payload) > 65536) throw new Error('Mutation receipt exceeds its size limit');
		if (provider() !== policy) throw new Error('Required mutation policy changed');
		const evidence = { policy, closed: false };
		try {
			return await evidenceScope.run(evidence, async () => {
				const sequence = await db.incrObjectField('mutation:sequence', 'value');
				if (!Number.isSafeInteger(Number(sequence))) throw new Error('Mutation sequence exhausted');
				await db.setObject(key, { nonce: ticket.nonce, sequence, payload });
				await db.sortedSetAdd('mutation:outbox', sequence, ticket.nonce);
				if (provider() !== policy) throw new Error('Required mutation policy changed');
				return { result, nonce: ticket.nonce, sequence };
			});
		} finally {
			evidence.closed = true;
		}
	});
};

// A delivery cursor belongs to the consumer's transaction, never to this read.
exports.readOutbox = async function (after = 0, limit = 100) {
	if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error('Invalid mutation outbox range');
	}
	const db = require('../database');
	const ids = await db.getSortedSetRangeByScore('mutation:outbox', 0, limit, after + 1, '+inf');
	return Promise.all(ids.map(async (nonce) => {
		const record = await db.getObject(`mutation:receipt:${nonce}`);
		if (!record?.payload || record.nonce !== nonce) throw new Error('Mutation outbox receipt is missing');
		const sequence = Number(record.sequence);
		const score = Number(await db.sortedSetScore('mutation:outbox', nonce));
		const receipt = JSON.parse(record.payload);
		if (!Number.isSafeInteger(sequence) || sequence <= after || sequence !== score ||
			!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !Object.keys(receipt).length) {
			throw new Error('Mutation outbox receipt is inconsistent');
		}
		return { nonce, sequence, receipt };
	}));
};
