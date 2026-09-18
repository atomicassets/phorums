'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

exports.current = () => context.getStore();
exports.run = (state, fn) => context.run(state, fn);
exports.defer = function (fn) {
	const state = context.getStore();
	if (!state) return false;
	if (state.closed) throw new Error('Atomic mutation context is closed');
	state.effects.push(fn);
	return true;
};
exports.detach = function (fn) {
	if (!exports.defer(fn)) setImmediate(fn);
};
