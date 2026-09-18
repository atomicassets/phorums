'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const nconf = require('nconf');
const db = require('../mocks/databasemock');
const user = require('../../src/user');
const categories = require('../../src/categories');
const topics = require('../../src/topics');
const posts = require('../../src/posts');
const plugins = require('../../src/plugins');
const mutations = require('../../src/mutations');

// The policy stands in for external verification, never for the mutation or DB.
describe('protected forum transaction', function () {
	let uid;
	let pid;
	let savedPlugins;
	const id = 'nodebb-plugin-test-policy';
	beforeEach(async () => {
		nconf.set('mutations:requiredPlugin', '');
		uid = await user.create({ username: `fixture${randomBytes(4).toString('hex')}` });
		const category = await categories.create({ name: 'Mutation fixture' });
		const result = await topics.post({ uid, cid: category.cid, title: 'Signed edit fixture', content: 'Original fixture content' });
		pid = result.postData.pid;
		savedPlugins = plugins.loadedPlugins;
		plugins.loadedPlugins = [...savedPlugins, { id }];
		plugins.libraries[id] = {
			mutationPolicy: {
				authorize: async request => ({ nonce: request.nonce }),
				validate: async () => true,
				check: async () => true,
				receipt: async ticket => ({ authorization: ticket.nonce, pid }),
			},
		};
		nconf.set('mutations:requiredPlugin', id);
	});
	afterEach(() => {
		nconf.set('mutations:requiredPlugin', '');
		plugins.loadedPlugins = savedPlugins;
		delete plugins.libraries[id];
	});

	it('commits a real post edit with its receipt and outbox membership', async () => {
		const nonce = randomBytes(32).toString('hex');
		await mutations.run({ nonce }, () => posts.edit({ uid, pid, content: 'Updated fixture content' }));
		assert.equal(await posts.getPostField(pid, 'content'), 'Updated fixture content');
		assert.ok(await db.getObject(`mutation:receipt:${nonce}`));
		assert.notEqual(await db.sortedSetScore('mutation:outbox', nonce), null);
	});

	it('rolls back a real post edit when receipt persistence fails', async () => {
		plugins.libraries[id].mutationPolicy.receipt = async () => { throw new Error('Receipt failure'); };
		const nonce = randomBytes(32).toString('hex');
		await assert.rejects(mutations.run({ nonce }, () => posts.edit({ uid, pid, content: 'Must not persist' })), /Receipt failure/);
		assert.equal(await posts.getPostField(pid, 'content'), 'Original fixture content');
		assert.equal(await db.getObject(`mutation:receipt:${nonce}`), null);
		assert.equal(await db.sortedSetScore('mutation:outbox', nonce), null);
	});
});
