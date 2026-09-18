'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nconf = require('nconf');
nconf.use('memory');
nconf.set('database', 'postgres');
nconf.set('base_dir', require('node:path').resolve(__dirname, '../..'));
nconf.set('url', 'https://forum.example.invalid');
nconf.set('relative_path', '');
nconf.set('upload_path', '/tmp/uploads');
nconf.set('upload_url', '/assets/uploads');
const db = require('../../src/database');
const context = require('../../src/database/atomic-context');
const opts = { host: process.env.PGHOST || 'localhost', port: 5432, username: 'forum', password: 'fixture-only', database: 'forum' };
const prefix = require('node:crypto').randomUUID();
before(async () => { await db.init(opts); });
after(async () => { await db.pool.end(); });

test('NodeBB hash, counter and sorted set writes roll back together', async () => {
	await assert.rejects(db.atomic('test:rollback', async () => {
		await db.setObject(`${prefix}:post`, { content: 'pending' });
		await db.incrObjectField(`${prefix}:sequence`, 'value');
		await db.sortedSetAdd(`${prefix}:outbox`, 1, 'receipt');
		assert.equal(await db.getObjectField(`${prefix}:post`, 'content'), 'pending');
		throw new Error('Receipt storage failed');
	}), /Receipt storage failed/);
	assert.equal(await db.getObject(`${prefix}:post`), null);
	assert.equal(await db.getObject(`${prefix}:sequence`), null);
	assert.deepEqual(await db.getSortedSetRange(`${prefix}:outbox`, 0, -1), []);
});

test('commits nested NodeBB writes and emits effects only after commit', async () => {
	const observations = [];
	await db.atomic('test:commit', async () => {
		await db.setObject(`${prefix}:committed`, { content: 'visible' });
		context.defer(async () => observations.push(await db.getObjectField(`${prefix}:committed`, 'content')));
		assert.deepEqual(observations, []);
	});
	assert.deepEqual(observations, ['visible']);
});

test('a separate reader cannot observe uncommitted content through the object cache', async () => {
	let release;
	let written;
	const wait = new Promise(resolve => { release = resolve; });
	const ready = new Promise(resolve => { written = resolve; });
	const mutation = db.atomic('test:isolation', async () => {
		await db.setObject(`${prefix}:private`, { content: 'uncommitted' });
		assert.equal(await db.getObjectField(`${prefix}:private`, 'content'), 'uncommitted');
		written();
		await wait;
	});
	await ready;
	try { assert.equal(await db.getObject(`${prefix}:private`), null); } finally { release(); }
	await mutation;
	assert.equal(await db.getObjectField(`${prefix}:private`, 'content'), 'uncommitted');
});

test('aborted mutations discard deferred effects', async () => {
	let called = false;
	await assert.rejects(db.atomic('test:effects', async () => {
		context.defer(() => { called = true; });
		throw new Error('Abort');
	}), /Abort/);
	assert.equal(called, false);
});

test('detached work scheduled inside a mutation runs once after commit', async () => {
	let runs = 0;
	let committedBeforeEffect;
	await db.atomic('test:detach', async () => {
		await db.setObject(`${prefix}:detach`, { value: 1 });
		context.detach(async () => {
			runs += 1;
			committedBeforeEffect = await db.getObjectField(`${prefix}:detach`, 'value');
			await db.setObject(`${prefix}:detach-effect`, { value: 2 });
		});
		assert.equal(runs, 0);
	});
	assert.equal(runs, 1);
	assert.equal(committedBeforeEffect, '1');
	assert.equal(await db.getObjectField(`${prefix}:detach-effect`, 'value'), '2');
});

test('aborted mutations discard detached work', async () => {
	let runs = 0;
	await assert.rejects(db.atomic('test:detach-abort', async () => {
		context.detach(() => { runs += 1; });
		throw new Error('Abort');
	}), /Abort/);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(runs, 0);
});

test('detached work outside a mutation runs on the next immediate', async () => {
	let runs = 0;
	context.detach(() => { runs += 1; });
	assert.equal(runs, 0);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(runs, 1);
});

test('notification delivery scheduled inside a mutation lands after commit', async () => {
	const notifications = require('../../src/notifications');
	const uid = 900000000 + Math.floor(Math.random() * 1000000);
	const nid = `${prefix}:notification`;
	const notification = await notifications.create({ nid, type: 'fixture', bodyShort: 'fixture', path: '/' });
	await db.atomic('test:notification', async () => {
		await notifications.push(notification, [uid]);
	});
	await new Promise(resolve => setTimeout(resolve, 2000));
	assert.equal(await db.isSortedSetMember(`uid:${uid}:notifications:unread`, nid), true);
});

test('detached work cannot reuse a released transaction', async () => {
	let late;
	await db.atomic('test:closed', async () => { late = require('node:async_hooks').AsyncLocalStorage.snapshot(); });
	await assert.rejects(async () => late(() => db.setObject(`${prefix}:late`, { value: 1 })), /Atomic mutation context is closed/);
	assert.equal(await db.getObject(`${prefix}:late`), null);
});

const mutations = require('../../src/mutations');
const plugins = require('../../src/plugins');
const { randomBytes } = require('node:crypto');
const policyId = 'nodebb-plugin-test-policy';
function installPolicy(overrides = {}) {
	const policy = {
		authorize: async request => ({ nonce: request.nonce }),
		validate: async () => true,
		check: async (ticket, action) => action === 'fixture.write',
		receipt: async ticket => ({ authorization: ticket.nonce, action: 'fixture.write' }),
		...overrides,
	};
	plugins.loadedPlugins = [{ id: policyId }];
	plugins.libraries[policyId] = { mutationPolicy: policy };
	nconf.set('mutations:requiredPlugin', policyId);
	return policy;
}
const nonce = () => randomBytes(32).toString('hex');

test('required plugin removal and unsupported backends reject before a mutation', async () => {
	installPolicy();
	await assert.rejects(mutations.check('fixture.write', []), /Verified mutation context is required/);
	plugins.loadedPlugins = [];
	await assert.rejects(mutations.run({ nonce: nonce() }, async () => assert.fail('must not run')), /Required mutation policy is unavailable/);
	installPolicy();
	nconf.set('database', 'redis');
	try {
		await assert.rejects(mutations.run({ nonce: nonce() }, async () => assert.fail('must not run')), /Protected mutations require PostgreSQL/);
	} finally { nconf.set('database', 'postgres'); }
});

test('guarded write, receipt and outbox commit together and reject replay', async () => {
	installPolicy();
	const id = nonce();
	const object = { write: async () => { await db.setObject(`${prefix}:guarded`, { value: id }); return id; } };
	mutations.guard(object, 'fixture', ['write']);
	await assert.rejects(object.write(), /Verified mutation context is required/);
	const committed = await mutations.run({ nonce: id }, () => object.write());
	assert.equal(committed.result, id);
	const rows = await mutations.readOutbox(committed.sequence - 1);
	assert.deepEqual(rows.find(row => row.nonce === id), {
		nonce: id, sequence: committed.sequence, receipt: { authorization: id, action: 'fixture.write' },
	});
	await assert.rejects(mutations.run({ nonce: id }, () => object.write()), /Mutation authorization was already consumed/);
});

test('concurrent submissions consume a nonce exactly once', async () => {
	installPolicy();
	const id = nonce();
	let applied = 0;
	const result = await Promise.allSettled([1, 2].map(() => mutations.run({ nonce: id }, async () => { applied += 1; })));
	assert.equal(applied, 1);
	assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
	assert.match(result.find(row => row.status === 'rejected').reason.message, /already consumed/);
});

test('receipt failure rolls back the mutation and leaves no outbox eligibility', async () => {
	installPolicy({ receipt: async () => { throw new Error('Receipt unavailable'); } });
	const id = nonce();
	await assert.rejects(mutations.run({ nonce: id }, async () => {
		await db.setObject(`${prefix}:receipt-failure`, { content: 'must roll back' });
	}), /Receipt unavailable/);
	assert.equal(await db.getObject(`${prefix}:receipt-failure`), null);
	assert.equal(await db.exists(`mutation:receipt:${id}`), false);
	assert.equal(await db.sortedSetScore('mutation:outbox', id), null);
});

test('revoked permission or changed revision prevents any protected write', async () => {
	installPolicy({ validate: async () => false });
	await assert.rejects(mutations.run({ nonce: nonce() }, async () => assert.fail('must not run')), /Mutation authorization is stale/);
});

test('a cascade outside the policy authorization aborts the outer mutation', async () => {
	installPolicy();
	await assert.rejects(mutations.run({ nonce: nonce() }, async () => {
		await db.setObject(`${prefix}:cascade`, { content: 'must roll back' });
		await mutations.check('fixture.unapproved-purge', []);
	}), /Mutation is outside the verified authorization/);
	assert.equal(await db.getObject(`${prefix}:cascade`), null);
});

test('outbox readers reject missing evidence rather than skipping it', async () => {
	installPolicy();
	const id = nonce();
	const { sequence } = await mutations.run({ nonce: id }, async () => {});
	// Simulate physical corruption outside the guarded application adapter.
	await db.pool.query('UPDATE legacy_hash SET data = data - $1 WHERE _key = $2', ['payload', `mutation:receipt:${id}`]);
	db.objectCache.reset();
	await assert.rejects(mutations.readOutbox(sequence - 1), /Mutation outbox receipt is missing/);
});

const entrypoints = [
	[require('../../src/categories'), ['create', 'update', 'purge', 'copySettingsFrom', 'copyPrivilegesFrom']],
	[require('../../src/posts'), ['addToQueue', 'removeFromQueue', 'submitFromQueue', 'editQueuedContent', 'updateQueuedPostsTopic', 'bookmark', 'unbookmark', 'create', 'edit', 'delete', 'restore', 'purge', 'upvote', 'downvote', 'unvote', 'setPostFields', 'changeOwner']],
	[require('../../src/topics'), ['toggleFollow', 'follow', 'unfollow', 'ignore', 'markUnread', 'markAsUnreadForAll', 'setUserBookmark', 'followTag', 'unfollowTag', 'addTags', 'removeTags', 'updateTopicTags', 'deleteTopicTags', 'deleteTags', 'post', 'reply', 'delete', 'restore', 'purge', 'merge', 'movePostToTopic', 'setTopicFields']],
	[require('../../src/topics').tools, ['delete', 'restore', 'purge', 'lock', 'unlock', 'pin', 'unpin', 'move', 'setPinExpiry']],
	[require('../../src/flags'), ['create', 'update', 'resolveFlag', 'appendNote', 'purge', 'rescindReport', 'deleteNote', 'addReport', 'appendHistory']],
	[require('../../src/groups'), ['updateCover', 'updateCoverPosition', 'removeCover', 'join', 'leave', 'create', 'destroy', 'update', 'requestMembership', 'acceptMembership', 'rejectMembership', 'invite']],
	[require('../../src/groups').ownership, ['grant', 'rescind']],
	[require('../../src/user'), ['deleteContent', 'deleteAccount', 'associateUpload', 'deleteUpload', 'appendModerationNote', 'setModerationNote', 'deleteModerationNote']],
	[require('../../src/posts').uploads, ['sync', 'associate', 'dissociate', 'dissociateAll', 'saveSize', 'cleanOrphans', 'deleteFromDisk']],
	[require('../../src/user').bans, ['ban', 'unban']],
	[require('../../src/topics').thumbs, ['associate', 'delete']],
	[require('../../src/topics').events, ['purge']],
	[require('../../src/topics').crossposts, ['add', 'remove', 'removeAll']],
	[require('../../src/api/users'), ['mute', 'unmute']],
];
entrypoints.forEach(([object, methods], index) => {
	for (const method of methods) {
		test(`core entrypoint group ${index} ${method} rejects unsigned calls`, async () => {
			installPolicy();
			await assert.rejects(object[method](), /Verified mutation context is required/);
		});
        test(`core entrypoint group ${index} ${method} requires its exact domain action`, async () => {
            installPolicy({ check: async (ticket, action) => action.startsWith('database.') });
            await assert.rejects(mutations.run({ nonce: nonce() }, () => object[method]()), /Mutation is outside the verified authorization/);
        });
	}
});

test('caught SQL failure cannot turn an aborted transaction into a successful mutation', async () => {
	await assert.rejects(db.atomic('test:poison', async () => {
		await db.setObject(`${prefix}:poison`, { value: 1 });
		try { await db.pool.query('SELECT 1 / 0'); } catch (err) { assert.equal(err.code, '22012'); }
	}), error => error.code === '22012');
	assert.equal(await db.getObject(`${prefix}:poison`), null);
});

test('a captured transaction client cannot write after commit', async () => {
	let captured;
	await db.atomic('test:captured', async () => {
		await db.transaction(async client => { captured = client; });
	});
	assert.throws(() => captured.query('SELECT 1'), /Atomic mutation context is closed/);
});

test('direct and bulk canonical storage writes cannot bypass the policy', async () => {
	installPolicy();
	for (const operation of [
		() => db.setObject(`post:${prefix}`, { content: 'unsigned' }),
		() => db.setObjectBulk([[`post:${prefix}`, { content: 'unsigned' }]]),
		() => db.setObjectField(`user:${prefix}`, 'banned', 1),
		() => db.sortedSetAdd('group:administrators:members', 1, '99'),
		() => db.rename(`${prefix}:unprotected`, `post:${prefix}`),
		() => db.deleteAll([`post:${prefix}`]),
	]) await assert.rejects(operation(), /Verified mutation context is required/);
	assert.equal(await db.getObject(`post:${prefix}`), null);
});

test('reputation storage cannot bypass the required policy', async () => {
	installPolicy();
	await assert.rejects(db.setObjectField(`user:${prefix}`, 'reputation', 1), /Verified mutation context is required/);
	await assert.rejects(db.sortedSetAdd('users:reputation', 1, prefix), /Verified mutation context is required/);
});

test('group cover mutations remain disabled until filesystem effects are audited', async () => {
	installPolicy({ check: async () => true });
	const Groups = require('../../src/groups');
	await assert.rejects(mutations.run({ nonce: nonce() }, () => Groups.updateCoverPosition('fixture', 'center')),
		/Unsupported protected mutation: groups\.updateCoverPosition/);
});

test('legacy callback entrypoints also reject unsigned writes', async () => {
	installPolicy();
	const error = await new Promise(resolve => require('../../src/posts').edit({}, resolve));
	assert.match(error.message, /Verified mutation context is required/);
});

test('plugin removal after evidence verification still prevents application', async () => {
	installPolicy({ authorize: async request => {
		plugins.loadedPlugins = [];
		return { nonce: request.nonce };
	} });
	await assert.rejects(mutations.run({ nonce: nonce() }, async () => assert.fail('must not run')), /Required mutation policy is unavailable/);
});

for (const [name, update] of [
	['setObjectField', key => db.setObjectField(key, 'value', 2)],
	['setObjectBulk', key => db.setObjectBulk([[key, { value: 2 }]])],
	['incrObjectFieldBy', key => db.incrObjectFieldBy(key, 'value', 1)],
	['incrObjectFieldByBulk', key => db.incrObjectFieldByBulk([[key, { value: 1 }]])],
]) {
	test(`${name} invalidates the cache after the database commit`, async () => {
		const key = `${prefix}:cache-race:${name}`;
		await db.setObject(key, { value: 1 });
		let release;
		let signal;
		const barrier = new Promise(resolve => { release = resolve; });
		const ready = new Promise(resolve => { signal = resolve; });
		const connect = db.pool.connect;
		let intercept = true;
		db.pool.connect = async function (...args) {
			const client = await connect(...args);
			if (!intercept) return client;
			intercept = false;
			const query = client.query;
			client.query = async function (...queryArgs) {
				if (queryArgs[0] === 'COMMIT') {
					signal();
					await barrier;
					client.query = query;
				}
				return query.apply(client, queryArgs);
			};
			return client;
		};
		const write = update(key);
		try {
			await ready;
			assert.equal((await db.getObject(key)).value, 1);
		} finally {
			release();
			db.pool.connect = connect;
		}
		await write;
		assert.equal((await db.getObject(key)).value, 2);
	});
}

test('coercible nonce values cannot enter the receipt namespace', async () => {
	installPolicy();
	await assert.rejects(mutations.run({ nonce: [nonce()] }, async () => assert.fail('must not run')), /Invalid verified mutation ticket/);
});

test('outbox readers reject a receipt with a mismatched sequence', async () => {
	installPolicy();
	const id = nonce();
	const { sequence } = await mutations.run({ nonce: id }, async () => {});
	await db.pool.query('UPDATE legacy_hash SET data = jsonb_set(data, ARRAY[$1::text], $2::jsonb) WHERE _key = $3', ['sequence', JSON.stringify(sequence + 1), `mutation:receipt:${id}`]);
	db.objectCache.reset();
	await assert.rejects(mutations.readOutbox(sequence - 1), /Mutation outbox receipt is inconsistent/);
});

test('empty receipts cannot commit an eligible outbox record', async () => {
	installPolicy({ receipt: async () => ({}) });
	const id = nonce();
	await assert.rejects(mutations.run({ nonce: id }, async () => {
		await db.setObject(`${prefix}:empty-receipt`, { content: 'must not persist' });
	}), /Mutation receipt is required/);
	assert.equal(await db.getObject(`${prefix}:empty-receipt`), null);
	assert.equal(await db.exists(`mutation:receipt:${id}`), false);
});

for (const key of ['attachment:fixture', 'diff:fixture', 'topicEvent:fixture', 'postsRemote:pid', 'topicsRemote:tid', 'uid:99:uploads', 'uid:99:moderation:notes', 'uid:99:moderation:note:1', 'tag:fixture', 'categoryRemote:fixture', 'upload:fixture:pids', 'groupslug:groupname', 'uid:99:bookmarks',
    'uid:99:ban:1', 'uid:99:bans:timestamp', 'uid:99:unban:1', 'uid:99:unbans:timestamp',
    'uid:99:mute:1', 'uid:99:mutes:timestamp', 'uid:99:unmute:1', 'uid:99:unmutes:timestamp',
    'users:banned', 'users:banned:expire', 'users:muted', 'users:flags',
    'uid:99:posts', 'uid:99:topics', 'uid:99:cids', 'crosspost:fixture', 'uid:99:crossposts']) {
    test(`storage protects ${key}`, async () => {
        installPolicy();
        await assert.rejects(db.setObject(key, { value: 1 }), /Verified mutation context is required/);
    });
}
test('receipt storage is reserved even inside an authorized mutation', async () => {
    installPolicy();
    await assert.rejects(db.setObject('mutation:receipt:forged', { value: 1 }), /Mutation evidence is reserved/);
    await assert.rejects(mutations.run({ nonce: nonce() }, async () => {
        await db.setObject('mutation:receipt:forged', { value: 1 });
    }), /Mutation evidence is reserved/);
});
test('plugin removal during receipt generation rolls back the write', async () => {
    installPolicy({ receipt: async () => { plugins.loadedPlugins = []; return { fixture: true }; } });
    const key = `${prefix}:removed-during-receipt`;
    await assert.rejects(mutations.run({ nonce: nonce() }, async () => db.setObject(key, { value: 1 })), /Required mutation policy is unavailable/);
    assert.equal(await db.getObject(key), null);
});
test('an uncertain COMMIT preserves its error and discards the connection', async () => {
    const original = new Error('connection lost at commit');
    const commands = [];
    let released;
    const client = { query: async sql => { commands.push(sql); if (sql === 'COMMIT') throw original; return {}; }, release: err => { released = err; } };
    const adapter = {};
    require('../../src/database/postgres/atomic')(adapter, { connect: async () => client, query: async () => ({}) });
    await assert.rejects(adapter.atomic('fixture', async () => {}), error => error === original && error.mutationOutcome === 'unknown');
    assert.equal(released, original);
    assert.equal(commands.includes('ROLLBACK'), false);
});

for (const receipt of [{ field: undefined }, { toJSON: () => null }, { toJSON: () => [] }, { toJSON: () => undefined }]) {
    test('serialized empty or non-object receipts roll back data', async () => {
        installPolicy({ receipt: async () => receipt });
        const id = nonce();
        await assert.rejects(mutations.run({ nonce: id }, async () => db.setObject(`${prefix}:${id}`, { value: 1 })), /Mutation receipt is required/);
        assert.equal(await db.getObject(`${prefix}:${id}`), null);
        assert.equal(await db.exists(`mutation:receipt:${id}`), false);
    });
}
test('inactive policies cannot preseed receipt evidence', async () => {
    nconf.clear('mutations:requiredPlugin');
    for (const key of ['mutation:receipt:forged', 'mutation:sequence', 'mutation:outbox']) {
        await assert.rejects(db.setObject(key, { value: 1 }), /Mutation evidence is reserved/);
    }
});
test('direct user flag associations require authorization', async () => {
    installPolicy();
    await assert.rejects(db.setObjectField('user:99', 'flagId', 1), /Verified mutation context is required/);
});
test('direct chat message flag associations require authorization', async () => {
    installPolicy();
    await assert.rejects(db.setObjectField('message:99', 'flagId', 1), /Verified mutation context is required/);
    await assert.rejects(db.setObject('message:99', { flagId: 1 }), /Verified mutation context is required/);
});
for (const rollbackFails of [true, false]) {
    test(`rollback failure ${rollbackFails} preserves the original error and releases safely`, async () => {
        const original = new Error('mutation failed');
        const rollback = new Error('rollback failed');
        let released;
        const client = { query: async sql => { if (sql === 'ROLLBACK' && rollbackFails) throw rollback; return {}; }, release: err => { released = err; } };
        const adapter = {};
        require('../../src/database/postgres/atomic')(adapter, { connect: async () => client, query: async () => ({}) });
        await assert.rejects(adapter.atomic('fixture', async () => { throw original; }), error => error === original);
        assert.equal(released, rollbackFails ? rollback : undefined);
    });
}
test('a guard installed after promisification delivers the policy error to a callback', async () => {
	installPolicy();
	const topics = require('../../src/topics');
	const err = await new Promise((resolve) => { topics.follow(1, 1, resolve); });
	assert.match(String(err && err.message), /Verified mutation context is required/);
});

test('unaudited irreversible operations reject even a permissive policy', async () => {
    installPolicy({ check: async () => true });
    for (const [object, method] of [[require('../../src/flags'), 'purge'], [require('../../src/flags'), 'rescindReport'], [require('../../src/user'), 'deleteUpload'], [require('../../src/posts'), 'submitFromQueue'], [require('../../src/posts').uploads, 'deleteFromDisk'],
        [require('../../src/user'), 'deleteContent'], [require('../../src/user'), 'deleteAccount'], [require('../../src/user'), 'associateUpload'],
        [require('../../src/user').bans, 'ban'],
        [require('../../src/user'), 'updateCoverPicture'], [require('../../src/user'), 'updateCoverPosition'],
        [require('../../src/user'), 'uploadCroppedPictureFile'], [require('../../src/user'), 'uploadCroppedPicture'],
        [require('../../src/user'), 'removeCoverPicture'], [require('../../src/user'), 'removeProfileImage']]) {
        await assert.rejects(mutations.run({ nonce: nonce() }, () => object[method]()), /Unsupported protected mutation/);
    }
});

test('newly guarded write surfaces stay reachable only through their own action', async () => {
    const surfaces = [
        [require('../../src/groups'), 'requestMembership', 'groups.requestMembership'],
        [require('../../src/groups'), 'acceptMembership', 'groups.acceptMembership'],
        [require('../../src/groups'), 'rejectMembership', 'groups.rejectMembership'],
        [require('../../src/groups'), 'invite', 'groups.invite'],
        [require('../../src/posts'), 'changeOwner', 'posts.changeOwner'],
        [require('../../src/topics').thumbs, 'associate', 'topics.thumbs.associate'],
        [require('../../src/topics').thumbs, 'delete', 'topics.thumbs.delete'],
        [require('../../src/topics').events, 'purge', 'topics.events.purge'],
        [require('../../src/topics').crossposts, 'add', 'topics.crossposts.add'],
        [require('../../src/topics').crossposts, 'remove', 'topics.crossposts.remove'],
        [require('../../src/topics').crossposts, 'removeAll', 'topics.crossposts.removeAll'],
        [require('../../src/topics').tools, 'setPinExpiry', 'topics.tools.setPinExpiry'],
        [require('../../src/api/users'), 'mute', 'user.mute'],
        [require('../../src/api/users'), 'unmute', 'user.unmute'],
    ];
    for (const [object, method, action] of surfaces) {
        const seen = [];
        installPolicy({ check: async (ticket, requested) => { seen.push(requested); return false; } });
        await assert.rejects(mutations.run({ nonce: nonce() }, () => object[method]()), /Mutation is outside the verified authorization/);
        assert.deepEqual(seen, [action]);
    }
});

test('topic deletion defers its federated Remove until after the commit', async () => {
    const topics = require('../../src/topics');
    const activitypub = require('../../src/activitypub');
    const tid = 990000000 + Math.floor(Math.random() * 1000000);
    const cid = 990000000 + Math.floor(Math.random() * 1000000);
    nconf.clear('mutations:requiredPlugin');
    await db.setObject(`topic:${tid}`, { tid, cid, mainPid: 0, deleted: 0 });
    const original = activitypub.out.remove.context;
    const calls = [];
    activitypub.out.remove.context = async (...args) => { calls.push(args); };
    let duringMutation;
    try {
        installPolicy({ check: async () => true });
        const committed = await mutations.run({ nonce: nonce() }, async () => {
            await topics.delete(tid, 1);
            duringMutation = calls.length;
        });
        assert.equal(typeof committed.sequence, 'number');
    } finally {
        activitypub.out.remove.context = original;
    }
    assert.equal(duringMutation, 0);
    assert.deepEqual(calls, [[1, tid]]);
    assert.equal(await db.getObjectField(`topic:${tid}`, 'deleted'), '1');
});

test('a guarded callback entrypoint authorizes the promise argument list', async () => {
    const seen = [];
    installPolicy({ check: async (ticket, action, args) => { seen.push({ action, args }); return false; } });
    const topics = require('../../src/topics');
    let err;
    await mutations.run({ nonce: nonce() }, async () => {
        err = await new Promise((resolve) => { topics.follow(7, 9, resolve); });
    });
    assert.match(String(err && err.message), /Mutation is outside the verified authorization/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].action, 'topics.follow');
    assert.deepEqual(seen[0].args, [7, 9]);
    assert.equal(seen[0].args.some(arg => typeof arg === 'function'), false);
});

test('the unread count is recomputed and emitted only after commit', async () => {
    nconf.clear('mutations:requiredPlugin');
    const topics = require('../../src/topics');
    const sockets = require('../../src/socket.io');
    const uid = 900000000 + Math.floor(Math.random() * 1000000);
    const originalUnread = topics.getUnreadTids;
    const originalIn = sockets.in;
    const emits = [];
    topics.getUnreadTids = async () => ({ '': 1, new: 0, watched: 0, unreplied: 0 });
    sockets.in = room => ({ emit: (event, payload) => emits.push({ room, event, payload }) });
    let duringMutation;
    try {
        await db.atomic('test:unread-count', async () => {
            await topics.pushUnreadCount(uid);
            duringMutation = emits.length;
        });
    } finally {
        topics.getUnreadTids = originalUnread;
        sockets.in = originalIn;
    }
    assert.equal(duringMutation, 0);
    assert.equal(emits.length, 1);
    assert.equal(emits[0].room, `uid_${uid}`);
    assert.equal(emits[0].event, 'event:unread.updateCount');
});

test('read markers defer their notification count push until after commit', async () => {
    nconf.clear('mutations:requiredPlugin');
    const topics = require('../../src/topics');
    const user = require('../../src/user');
    const notifications = require('../../src/notifications');
    const uid = 900000000 + Math.floor(Math.random() * 1000000);
    const originalUnread = user.notifications.getUnreadByField;
    const originalMark = notifications.markReadMultiple;
    const originalPush = user.notifications.pushCount;
    const pushes = [];
    user.notifications.getUnreadByField = async () => [`${prefix}:nid`];
    notifications.markReadMultiple = async () => {};
    user.notifications.pushCount = async id => { pushes.push(id); };
    let duringMutation;
    try {
        await db.atomic('test:read-markers', async () => {
            await topics.markTopicNotificationsRead([1], uid);
            duringMutation = pushes.length;
        });
    } finally {
        user.notifications.getUnreadByField = originalUnread;
        notifications.markReadMultiple = originalMark;
        user.notifications.pushCount = originalPush;
    }
    assert.equal(duringMutation, 0);
    assert.deepEqual(pushes, [uid]);
});

test('available reports a verified context only inside an authorized mutation', async () => {
    nconf.clear('mutations:requiredPlugin');
    assert.equal(mutations.available(), true);
    installPolicy();
    assert.equal(mutations.available(), false);
    let insideMutation;
    await mutations.run({ nonce: nonce() }, async () => { insideMutation = mutations.available(); });
    assert.equal(insideMutation, true);
    plugins.loadedPlugins = [];
    assert.equal(mutations.available(), false);
});

test('read-time pin expiry skips its write without a verified context', async () => {
    nconf.clear('mutations:requiredPlugin');
    const topics = require('../../src/topics');
    const tid = 980000000 + Math.floor(Math.random() * 1000000);
    const cid = 980000000 + Math.floor(Math.random() * 1000000);
    await db.setObject(`topic:${tid}`, {
        tid, cid, pinned: 1, pinExpiry: 1, deleted: 0, mainPid: 0,
        lastposttime: 1, timestamp: 1, postcount: 1, viewcount: 1, votes: 0,
    });
    installPolicy();
    assert.deepEqual(await topics.tools.checkPinExpiry([tid]), [tid]);
    assert.equal(String(await db.getObjectField(`topic:${tid}`, 'pinned')), '1');
    assert.equal(String(await db.getObjectField(`topic:${tid}`, 'pinExpiry')), '1');
});

function installSpyPolicy() {
	const seen = [];
	installPolicy({ check: async (ticket, action) => { seen.push(action); return false; } });
	return seen;
}

test('read-time crosspost repair writes its scores without a verified context', async () => {
	const seen = installSpyPolicy();
	const topics = require('../../src/topics');
	const tid = 970000000 + Math.floor(Math.random() * 1000000);
	const cid = 970000000 + Math.floor(Math.random() * 1000000);
	await topics.crossposts.syncCrosspostedTopicCids(
		[{ id: `${prefix}:crosspost`, cid, tid, uid: 1, timestamp: 1 }],
		{ tid, pinned: 0, postcount: 5, votes: 1, viewcount: 9 }
	);
	assert.equal(await db.sortedSetScore(`cid:${cid}:tids:posts`, tid), 5);
	assert.equal(await db.sortedSetScore(`cid:${cid}:tids:votes`, tid), 1);
	assert.equal(await db.sortedSetScore(`cid:${cid}:tids:views`, tid), 9);
	assert.deepEqual(seen, []);
});

test('read markers advance the reader state without a verified context or a policy call', async () => {
	nconf.clear('mutations:requiredPlugin');
	const topics = require('../../src/topics');
	const tid = 960000000 + Math.floor(Math.random() * 1000000);
	const uid = 960000000 + Math.floor(Math.random() * 1000000);
	await db.setObject(`topic:${tid}`, { tid, cid: 1, lastposttime: 1, timestamp: 1, deleted: 0, mainPid: 0 });
	const seen = installSpyPolicy();
	assert.equal(await topics.markAsRead([tid], uid), true);
	await topics.markTopicNotificationsRead([tid], uid);
	await topics.markAllRead(uid);
	assert.ok(await db.sortedSetScore(`uid:${uid}:tids_read`, tid) > 0);
	assert.deepEqual(seen, []);
});

for (const [label, cid] of [['a numeric category', 950000000 + Math.floor(Math.random() * 1000000)], ['a remote category id containing colons', 'https://remote.example.invalid/category/1']]) {
	test(`a view count increment writes without a verified context in ${label}`, async () => {
		nconf.clear('mutations:requiredPlugin');
		const topics = require('../../src/topics');
		const tid = 950000000 + Math.floor(Math.random() * 1000000);
		await db.setObject(`topic:${tid}`, { tid, cid, viewcount: 0, deleted: 0, mainPid: 0 });
		const seen = installSpyPolicy();
		await topics.increaseViewCount({ uid: 1, session: {} }, tid);
		assert.equal(String(await db.getObjectField(`topic:${tid}`, 'viewcount')), '1');
		assert.equal(await db.sortedSetScore(`cid:${cid}:tids:views`, tid), 1);
		assert.equal(await db.sortedSetScore('topics:views', tid), typeof cid === 'number' ? 1 : null);
		assert.deepEqual(seen, []);
	});
}

test('writes outside the telemetry and derived tables still need a verified context', async () => {
	installPolicy();
	const tid = 940000000 + Math.floor(Math.random() * 1000000);
	const cid = 940000000 + Math.floor(Math.random() * 1000000);
	for (const operation of [
		() => db.incrObjectFieldBy(`topic:${tid}`, 'postcount', 1),
		() => db.setObjectField(`topic:${tid}`, 'viewcount', 5),
		() => db.incrObjectFieldBy(`topic:${tid}`, 'viewcount', -1000),
		() => db.incrObjectFieldBy(`topic:${tid}`, 'viewcount', 2),
		() => db.sortedSetRemove(`cid:${cid}:tids:views`, tid),
		() => db.sortedSetAddBulk([[`cid:${cid}:tids`, 1, tid], [`cid:${cid}:tids:views`, 1, tid]]),
		() => db.incrObjectFieldBy(`topic:${tid}:posts`, 'viewcount', 1),
		() => db.delete('topics:views'),
	]) await assert.rejects(operation(), /Verified mutation context is required/);
	assert.equal(await db.getObject(`topic:${tid}`), null);
	assert.equal(await db.sortedSetScore(`cid:${cid}:tids`, tid), null);
});

test('telemetry and derived writes never reach the policy inside a mutation', async () => {
	const seen = [];
	installPolicy({ check: async (ticket, action) => { seen.push(action); return action === 'fixture.write'; } });
	const tid = 930000000 + Math.floor(Math.random() * 1000000);
	const cid = 930000000 + Math.floor(Math.random() * 1000000);
	await mutations.run({ nonce: nonce() }, async () => {
		await mutations.check('fixture.write', []);
		await db.incrObjectFieldBy(`topic:${tid}`, 'viewcount', 1);
		await db.sortedSetsAdd([`cid:${cid}:tids:posts`, `cid:${cid}:tids:votes`], 2, tid);
		await db.sortedSetIncrBy(`cid:${cid}:tids:votes`, 1, tid);
		await db.sortedSetIncrByBulk([[`cid:${cid}:tids:views`, 1, tid]]);
	});
	assert.deepEqual(seen, ['fixture.write']);
	assert.equal(await db.sortedSetScore(`cid:${cid}:tids:votes`, tid), 3);
});

test('unread, follow, ignore and bookmark actions still require a verified context', async () => {
	installPolicy();
	const topics = require('../../src/topics');
	for (const operation of [
		() => topics.markUnread(1, 1),
		() => topics.markAsUnreadForAll(1),
		() => topics.follow(1, 1),
		() => topics.ignore(1, 1),
		() => topics.setUserBookmark(1, 1, 1),
	]) await assert.rejects(operation(), /Verified mutation context is required/);
});

test('a swallowed connection refusal cannot reach a commit', async () => {
    nconf.clear('mutations:requiredPlugin');
    let caught;
    await assert.rejects(db.atomic('test:connect-refusal', async () => {
        await db.setObject(`${prefix}:connect-refusal`, { value: 1 });
        try {
            await db.pool.connect();
        } catch (err) {
            caught = err;
        }
    }), /Independent connections are forbidden inside an atomic mutation/);
    assert.match(String(caught && caught.message), /Independent connections are forbidden inside an atomic mutation/);
    assert.equal(await db.getObject(`${prefix}:connect-refusal`), null);
});
