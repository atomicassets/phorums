'use strict';

const assert = require('node:assert/strict');
const nconf = require('nconf');
require('./mocks/databasemock');

if (nconf.get('database') === 'postgres') {
	require('./mutations/forum');
} else {
	describe('required mutation policy backend', () => {
		it('rejects protected mutations without PostgreSQL', async () => {
			const plugins = require('../src/plugins');
			const mutations = require('../src/mutations');
			const id = 'nodebb-plugin-test-policy';
			const loaded = plugins.loadedPlugins;
			plugins.loadedPlugins = [...loaded, { id }];
			plugins.libraries[id] = {
				mutationPolicy: {
					authorize() {}, validate() {}, check() {}, receipt() {},
				},
			};
			nconf.set('mutations:requiredPlugin', id);
			try {
				await assert.rejects(mutations.run({}, () => assert.fail('must not run')), /Protected mutations require PostgreSQL/);
			} finally {
				nconf.set('mutations:requiredPlugin', '');
				plugins.loadedPlugins = loaded;
				delete plugins.libraries[id];
			}
		});
	});
}
