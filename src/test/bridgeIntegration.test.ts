/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';

import { devContainerDown, devContainerStop, devContainerUp, shellExec } from './testUtils';

describe('Internal bridge integration', function () {
	this.timeout('180s');

	if (process.platform !== 'darwin') {
		return;
	}

	const testFolder = path.join(__dirname, 'configs/bridge-auth');
	const cli = `node ${path.resolve(__dirname, '..', '..', 'devcontainer.js')}`;
	const browserResponsePath = '/tmp/devcontainer-bridge-browser-response.txt';
	const env = {
		...process.env,
		DEVCONTAINER_BRIDGE_OPEN_COMMAND: `curl -fsS "$DEVCONTAINER_BRIDGE_URL" >${browserResponsePath} &`,
	};

	async function waitForBrowserResponse() {
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const contents = await fs.readFile(browserResponsePath, 'utf8');
				if (contents) {
					return contents;
				}
			} catch {
				// File is created asynchronously by the host-side open command.
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		throw new Error('Timed out waiting for browser callback response');
	}

	async function runAuthDemo(containerId: string) {
		await fs.rm(browserResponsePath, { force: true });
		await shellExec(`docker exec ${containerId} /bin/sh -lc '/workspaces/cli/src/test/configs/bridge-auth/run-auth-demo.sh 8124'`, { env }, true);
		const result = await shellExec(`docker exec ${containerId} /bin/sh -lc 'cat /tmp/auth-demo-result.txt'`, { env }, true);
		const browser = await waitForBrowserResponse();
		assert.match(result.stdout, /GET \/callback\?code=demo-code&state=demo-state HTTP\/1\.1/);
		assert.match(browser, /auth demo ok/);
	}

	it('forwards localhost auth callbacks on first start and container reuse', async () => {
		let containerId: string | null = null;
		try {
			const firstUp = await devContainerUp(cli, testFolder, { env, logLevel: 'trace', extraArgs: '--bridge' });
			containerId = firstUp.containerId;
			await runAuthDemo(containerId);

			await devContainerStop({ containerId });

			const resumed = await devContainerUp(cli, testFolder, { env, logLevel: 'trace', extraArgs: '--bridge' });
			containerId = resumed.containerId;
			await runAuthDemo(containerId);
		} finally {
			await devContainerDown({ containerId, doNotThrow: true });
		}
	});
});
