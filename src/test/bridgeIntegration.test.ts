/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';

import { devContainerDown, devContainerStop, devContainerUp, shellExec } from './testUtils';

describe('Internal bridge integration', function () {
	this.timeout('180s');

	if (process.platform !== 'darwin') {
		return;
	}

	const testFolder = path.join(__dirname, 'configs/bridge-auth');
	const cli = `node ${path.resolve(__dirname, '..', '..', 'devcontainer.js')}`;
	const env = {
		...process.env,
		DEVCONTAINER_BRIDGE_OPEN_COMMAND: 'curl -fsS "$DEVCONTAINER_BRIDGE_URL" >/dev/null &',
	};

	async function runAuthDemo(containerId: string) {
		await shellExec(`docker exec ${containerId} /bin/sh -lc '/workspaces/cli/src/test/configs/bridge-auth/run-auth-demo.sh 8124'`, { env }, true);
		const result = await shellExec(`docker exec ${containerId} /bin/sh -lc 'cat /tmp/auth-demo-result.txt'`, { env }, true);
		assert.match(result.stdout, /GET \/callback\?code=demo-code&state=demo-state HTTP\/1\.1/);
	}

	it('forwards localhost auth callbacks on first start and container reuse', async () => {
		let containerId: string | null = null;
		try {
			const firstUp = await devContainerUp(cli, testFolder, { env, logLevel: 'trace' });
			containerId = firstUp.containerId;
			await runAuthDemo(containerId);

			await devContainerStop({ containerId });

			const resumed = await devContainerUp(cli, testFolder, { env, logLevel: 'trace' });
			containerId = resumed.containerId;
			await runAuthDemo(containerId);
		} finally {
			await devContainerDown({ containerId, doNotThrow: true });
		}
	});
});
