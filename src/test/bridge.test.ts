/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import { bridgeLabels, parseListeningPorts } from '../spec-bridge/bridge';

describe('Internal bridge', () => {
	it('parses listening ports from proc net tables', () => {
		const contents = [
			'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
			'   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0',
			'   1: 00000000000000000000000000000001:0568 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0',
			'   2: 0100007F:15B3 0100007F:1770 01 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0',
		].join('\n');

		assert.deepStrictEqual([...parseListeningPorts(contents)].sort((a, b) => a - b), [1384, 8080]);
	});

	it('emits bridge labels only when enabled', () => {
		assert.deepStrictEqual(bridgeLabels(undefined), []);
		assert.deepStrictEqual(bridgeLabels({
			sessionId: 'session-1',
			host: 'host.docker.internal',
			port: 1234,
			token: 'token',
			configPath: '/tmp/config.json',
			hostMountPath: '/tmp/bridge',
			containerMountPath: '/tmp/devcontainer-cli-bridge',
		}), [
			'devcontainer.bridge.session=session-1',
			'devcontainer.bridge.enabled=true',
		]);
	});
});
