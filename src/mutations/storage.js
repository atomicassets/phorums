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
			if (keys.some(protectedKey) || recordModeration) {
				await require('.').check(`database.${name}`, args);
			}
			return original.apply(this, args);
		};
	}
};
