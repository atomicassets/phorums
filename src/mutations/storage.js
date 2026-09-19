'use strict';

// Guard canonical content, membership, crosspost and moderation-history records
// even when a caller bypasses the higher-level post/topic methods. Ban and mute
// history is evidence of a moderation decision, so it is protected like content.
// Policies authorize exact writes.
const protectedKey = key => typeof key === 'string' && (
	/^(?:attachment|attachments|diff|topicEvent|postsRemote|topicsRemote|post|posts|pid|topic|topics|tid|flag|flags|group|groups|category|categories|categoryRemote|cid|tag|upload|crosspost):/.test(key) ||
	/^users:(?:reputation|banned|muted|flags)(?::|$)/.test(key) ||
	key === 'groupslug:groupname' ||
	/^uid:[^:]+:(?:groups|upvote|downvote|bookmarks|uploads|moderation|posts|topics|cids|crossposts)(?::|$)/.test(key) ||
	/^uid:[^:]+:(?:unbans|unban|bans|ban|unmutes|unmute|mutes|mute)(?::|$)/.test(key)
);
// Two frozen core tables name writes that stay outside the policy boundary by
// design. `telemetry` holds the view counter, a statistic of anonymous events,
// and matches its field and its delta as well as its key, so only the single
// page-view increment passes. Its key names one topic record by the two
// id shapes core assigns, a positive integer or a UUID, so no other
// `topic:`-prefixed record matches. `derived` holds category sort
// indexes whose score projects a `topic:<tid>` field. Neither table permits
// removal, deletion, rename, or expiry, and a call that names any other
// protected key still goes to the policy.
const telemetry = Object.freeze([
	Object.freeze({ key: /^topic:(?:[1-9]\d*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, field: 'viewcount', delta: 1, methods: Object.freeze(['incrObjectFieldBy']) }),
]);
const derived = Object.freeze([
	Object.freeze({
		keys: Object.freeze([/^topics:views$/, /^cid:.+:tids:views$/, /^cid:.+:tids:posts$/, /^cid:.+:tids:votes$/]),
		methods: Object.freeze(['sortedSetAdd', 'sortedSetsAdd', 'sortedSetAddBulk', 'sortedSetIncrBy', 'sortedSetIncrByBulk']),
	}),
]);
const outsideBoundary = (name, key, args) => typeof key === 'string' && (
	telemetry.some(entry => entry.methods.includes(name) && entry.key.test(key) &&
		args[1] === entry.field && args[2] === entry.delta) ||
	derived.some(entry => entry.methods.includes(name) && entry.keys.some(pattern => pattern.test(key)))
);
const methods = [
	'setObject', 'setObjectBulk', 'setObjectField', 'deleteObjectField', 'deleteObjectFields',
	'incrObjectField', 'decrObjectField', 'incrObjectFieldBy', 'incrObjectFieldByBulk',
	'delete', 'deleteAll', 'set', 'increment', 'rename', 'expire', 'expireAt', 'pexpire', 'pexpireAt',
	'setAdd', 'setAddBulk', 'setsAdd', 'setRemove', 'setRemoveRandom', 'setsRemove',
	'sortedSetAdd', 'sortedSetsAdd', 'sortedSetAddBulk', 'sortedSetRemove', 'sortedSetsRemove',
	'sortedSetRemoveBulk', 'sortedSetsRemoveRangeByScore', 'sortedSetIncrBy', 'sortedSetIncrByBulk',
	'sortedSetUnionStore', 'sortedSetIntersectStore', 'sortedSetRemoveRangeByLex',
	'listPrepend', 'listAppend', 'listRemoveLast', 'listRemoveAll', 'listTrim',
	'flushdb', 'emptydb',
];

module.exports = function (db) {
	for (const name of methods) {
		if (typeof db[name] !== 'function') continue;
		const original = db[name];
		db[name] = async function (...args) {
			let keys = args[0];
			if (name.endsWith('Bulk') && Array.isArray(keys) && Array.isArray(keys[0])) keys = keys.map(row => row[0]);
			keys = Array.isArray(keys) ? keys : [keys];
			if (name === 'rename') keys = [...keys, args[1]];
			if (keys.some(key => typeof key === 'string' && key.startsWith('mutation:'))) {
				require('.').checkEvidenceWrite();
			}
			if (!require('nconf').get('mutations:requiredPlugin')) return original.apply(this, args);
			if (['flushdb', 'emptydb'].includes(name)) {
				await require('.').check(`database.${name}`, args);
			}
			// A chat message record carries the same flag association as a user record.
			const moderatedRecord = keys.some(key => /^(?:user|message):[^:]+$/.test(key));
			const recordModeration = moderatedRecord && (
				['delete', 'deleteAll', 'rename', 'expire', 'expireAt', 'pexpire', 'pexpireAt'].includes(name) ||
				/"(?:flagId|banned|banned:expire|muted|mutedUntil|mutedReason|reputation)"/.test(JSON.stringify(args))
			);
			if (keys.some(key => protectedKey(key) && !outsideBoundary(name, key, args)) || recordModeration) {
				await require('.').check(`database.${name}`, args);
			}
			return original.apply(this, args);
		};
	}
};
