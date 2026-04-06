/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { DockerResolverParameters } from '../spec-node/utils';
import { Mount } from '../spec-configuration/containerFeaturesConfiguration';
import { MergedDevContainerConfig } from '../spec-node/imageMetadata';
import { LogLevel } from '../spec-utils/log';

const bridgeFolderName = 'bridge';
const containerBridgeRoot = '/tmp/devcontainer-cli-bridge';
const containerBridgeBin = `${containerBridgeRoot}/bin`;
const bridgeSessionLabel = 'devcontainer.bridge.session';
const bridgeEnabledLabel = 'devcontainer.bridge.enabled';

export interface BridgeSession {
	sessionId: string;
	host: string;
	port: number;
	token: string;
	configPath: string;
	pidPath: string;
	hostMountPath: string;
	containerMountPath: string;
}

interface BridgeConfigFile {
	dockerPath: string;
	dockerEnv: NodeJS.ProcessEnv;
	containerId: string;
	controlPort: number;
	token: string;
	scanIntervalMs: number;
	containerHostname: string;
	sessionDir: string;
	pidPath: string;
}

interface BridgePrepareResult {
	bridge: BridgeSession | undefined;
	mergedConfig: MergedDevContainerConfig;
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function findFreePort(host = '127.0.0.1') {
	return await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, host, () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(err => err ? reject(err) : resolve(port));
		});
	});
}

async function ensureDir(dir: string) {
	await fs.promises.mkdir(dir, { recursive: true });
}

async function writeExecutable(filePath: string, content: string) {
	await fs.promises.writeFile(filePath, content, { mode: 0o755 });
	await fs.promises.chmod(filePath, 0o755);
}

function createOpenShim() {
	const python3Command = `import json, os, sys, urllib.request; req = urllib.request.Request("http://%s:%s/open" % (os.environ[\"DEVCONTAINER_BRIDGE_HOST\"], os.environ[\"DEVCONTAINER_BRIDGE_PORT\"]), data=json.dumps({\"url\": sys.argv[1], \"token\": os.environ.get(\"DEVCONTAINER_BRIDGE_TOKEN\", \"\")}).encode(), headers={\"content-type\": \"application/json\"}); urllib.request.urlopen(req).read()`;
	const python2Command = `import json, os, sys; import urllib2; req = urllib2.Request("http://%s:%s/open" % (os.environ[\"DEVCONTAINER_BRIDGE_HOST\"], os.environ[\"DEVCONTAINER_BRIDGE_PORT\"]), json.dumps({\"url\": sys.argv[1], \"token\": os.environ.get(\"DEVCONTAINER_BRIDGE_TOKEN\", \"\")}), {\"content-type\": \"application/json\"}); urllib2.urlopen(req).read()`;
	return `#!/bin/sh
set -eu

if [ $# -lt 1 ]; then
  exit 1
fi

url="$1"
host="${'$'}{DEVCONTAINER_BRIDGE_HOST:-host.docker.internal}"
port="${'$'}{DEVCONTAINER_BRIDGE_PORT:-0}"
token="${'$'}{DEVCONTAINER_BRIDGE_TOKEN:-}"

if command -v curl >/dev/null 2>&1; then
  exec curl -fsS -X POST --data-urlencode "url=${'$'}url" --data-urlencode "token=${'$'}token" "http://${'$'}host:${'$'}port/open"
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 -c ${shellQuote(python3Command)} "$url"
fi

if command -v python >/dev/null 2>&1; then
  exec python -c ${shellQuote(python2Command)} "$url"
fi

printf 'No supported HTTP client found for browser bridge\n' >&2
exit 127
`;
}

async function writeBridgeScripts(targetDir: string) {
	const binDir = path.join(targetDir, 'bin');
	await ensureDir(binDir);
	const openShim = createOpenShim();
	await writeExecutable(path.join(binDir, 'devcontainer-open'), openShim);
	await writeExecutable(path.join(binDir, 'xdg-open'), `#!/bin/sh\nexec ${containerBridgeBin}/devcontainer-open "$@"\n`);
}

function mergeMounts(existing: (Mount | string)[] | undefined, mount: string): (Mount | string)[] {
	return [...(existing || []), mount];
}

export async function prepareBridge(params: DockerResolverParameters, mergedConfig: MergedDevContainerConfig): Promise<BridgePrepareResult> {
	const { common } = params;
	if (common.cliHost.platform !== 'darwin') {
		return { bridge: undefined, mergedConfig };
	}

	const bridgeRoot = path.join(common.persistedFolder, bridgeFolderName);
	const sessionId = randomUUID();
	const sessionDir = path.join(bridgeRoot, sessionId);
	await ensureDir(sessionDir);
	await writeBridgeScripts(sessionDir);

	const port = await findFreePort('0.0.0.0');
	const token = randomBytes(24).toString('hex');
	const bridge: BridgeSession = {
		sessionId,
		host: 'host.docker.internal',
		port,
		token,
		configPath: path.join(sessionDir, 'bridge-config.json'),
		pidPath: path.join(sessionDir, 'bridge.pid'),
		hostMountPath: sessionDir,
		containerMountPath: containerBridgeRoot,
	};

	const configuredPath = mergedConfig.containerEnv?.PATH;
	const bridgePath = configuredPath ? `${containerBridgeBin}:${configuredPath}` : `${containerBridgeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
	const containerEnv = {
		...(mergedConfig.containerEnv || {}),
		BROWSER: `${containerBridgeBin}/devcontainer-open`,
		DEVCONTAINER_BRIDGE_HOST: bridge.host,
		DEVCONTAINER_BRIDGE_PORT: String(bridge.port),
		DEVCONTAINER_BRIDGE_TOKEN: bridge.token,
		PATH: bridgePath,
	};

	const mount = `type=bind,source=${bridge.hostMountPath},target=${bridge.containerMountPath}`;

	return {
		bridge,
		mergedConfig: {
			...mergedConfig,
			containerEnv,
			mounts: mergeMounts(mergedConfig.mounts, mount),
		}
	};
}

function envListToObject(env: string[] | null | undefined): NodeJS.ProcessEnv {
	return (env || []).reduce((acc, entry) => {
		const index = entry.indexOf('=');
		if (index >= 0) {
			acc[entry.slice(0, index)] = entry.slice(index + 1);
		}
		return acc;
	}, {} as NodeJS.ProcessEnv);
}

export async function restoreBridge(params: DockerResolverParameters, container: { Config: { Env: string[] | null; Labels: Record<string, string | undefined> | null; }; Mounts: { Source: string; Destination: string; }[]; }): Promise<BridgeSession | undefined> {
	if (params.common.cliHost.platform !== 'darwin') {
		return undefined;
	}
	const labels = container.Config.Labels || {};
	if (labels[bridgeEnabledLabel] !== 'true') {
		return undefined;
	}
	const env = envListToObject(container.Config.Env);
	const sessionId = labels[bridgeSessionLabel];
	const port = Number(env.DEVCONTAINER_BRIDGE_PORT || '0');
	const token = env.DEVCONTAINER_BRIDGE_TOKEN;
	const mount = container.Mounts.find(candidate => candidate.Destination === containerBridgeRoot);
	if (!sessionId || !port || !token || !mount) {
		return undefined;
	}
	await ensureDir(mount.Source);
	await writeBridgeScripts(mount.Source);
	return {
		sessionId,
		host: env.DEVCONTAINER_BRIDGE_HOST || 'host.docker.internal',
		port,
		token,
		configPath: path.join(mount.Source, 'bridge-config.json'),
		pidPath: path.join(mount.Source, 'bridge.pid'),
		hostMountPath: mount.Source,
		containerMountPath: containerBridgeRoot,
	};
}

async function stopExistingBridge(bridge: BridgeSession) {
	try {
		const pidText = await fs.promises.readFile(bridge.pidPath, 'utf8');
		const pid = Number(pidText.trim());
		if (pid > 0) {
			process.kill(pid, 'SIGTERM');
			for (let attempt = 0; attempt < 20; attempt++) {
				try {
					process.kill(pid, 0);
					await new Promise(resolve => setTimeout(resolve, 100));
				} catch {
					break;
				}
			}
		}
	} catch {
		// Ignore missing pid files and already-stopped processes.
	}
}

async function waitForBridge(port: number) {
	for (let attempt = 0; attempt < 50; attempt++) {
		const ready = await new Promise<boolean>((resolve) => {
			const socket = net.createConnection({ host: '127.0.0.1', port });
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});
		if (ready) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for bridge on port ${port}`);
}

async function isContainerRunning(config: BridgeConfigFile) {
	const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
		const child = spawn(config.dockerPath, ['inspect', '--type', 'container', '--format', '{{.State.Status}}', config.containerId], {
			env: config.dockerEnv,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		let stdout = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', chunk => stdout += chunk);
		child.once('exit', code => resolve({ code, stdout }));
		child.once('error', () => resolve({ code: 1, stdout }));
	});
	return result.code === 0 && result.stdout.trim() === 'running';
}

export async function startBridge(params: DockerResolverParameters, bridge: BridgeSession | undefined, containerId: string, containerHostname: string) {
	if (!bridge) {
		return;
	}
	await stopExistingBridge(bridge);

	const config: BridgeConfigFile = {
		dockerPath: params.dockerCLI,
		dockerEnv: params.dockerEnv,
		containerId,
		controlPort: bridge.port,
		token: bridge.token,
		scanIntervalMs: 1500,
		containerHostname,
		sessionDir: bridge.hostMountPath,
		pidPath: bridge.pidPath,
	};
	await fs.promises.writeFile(bridge.configPath, JSON.stringify(config));

	const cliEntry = path.join(params.common.extensionPath, 'devcontainer.js');
	const child = spawn(process.execPath, [cliEntry, 'bridge-supervisor', '--config', bridge.configPath], {
		cwd: params.common.cliHost.cwd,
		detached: true,
		stdio: 'ignore',
		env: process.env,
	});
	child.unref();
	await waitForBridge(bridge.port);
	params.common.output.write(`Started internal bridge for container ${containerId}.`, LogLevel.Trace);
}

export function parseListeningPorts(contents: string) {
	const ports = new Set<number>();
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*\d+:\s+[0-9A-F]{8,32}:([0-9A-F]{4})\s+[0-9A-F]{8,32}:[0-9A-F]{4}\s+0A\s/i);
		if (!match) {
			continue;
		}
		const port = Number.parseInt(match[1], 16);
		if (port > 0) {
			ports.add(port);
		}
	}
	return ports;
}

async function readConfig(configPath: string): Promise<BridgeConfigFile> {
	return JSON.parse(await fs.promises.readFile(configPath, 'utf8')) as BridgeConfigFile;
}

function connectorCommand(port: number) {
	const py = `import socket,sys,threading; s=socket.create_connection(("127.0.0.1",${port})); t=threading.Thread(target=lambda:(sys.stdout.buffer.write(s.makefile("rb",0).read()) or sys.stdout.flush()), daemon=True); t.start();\nwhile True:\n data=sys.stdin.buffer.read(65536)\n if not data: break\n s.sendall(data)\ns.shutdown(socket.SHUT_WR); t.join()`;
	const bashTcp = `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3 & cat >&3; wait`;
	return `if command -v nc >/dev/null 2>&1; then exec nc 127.0.0.1 ${port}; elif command -v python3 >/dev/null 2>&1; then exec python3 -c ${shellQuote(py)}; elif command -v python >/dev/null 2>&1; then exec python -c ${shellQuote(py)}; elif command -v bash >/dev/null 2>&1; then exec bash -lc ${shellQuote(bashTcp)}; else echo bridge connector missing >&2; exit 127; fi`;
}

async function ensureOpen(url: string) {
	const overrideCommand = process.env.DEVCONTAINER_BRIDGE_OPEN_COMMAND;
	if (overrideCommand) {
		return await new Promise<void>((resolve, reject) => {
			const child = spawn('/bin/sh', ['-lc', overrideCommand], {
				stdio: 'ignore',
				env: {
					...process.env,
					DEVCONTAINER_BRIDGE_URL: url,
				},
			});
			child.once('error', reject);
			child.once('exit', code => code === 0 ? resolve() : reject(new Error(`open command exited with ${code}`)));
		});
	}
	return await new Promise<void>((resolve, reject) => {
		const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
			stdio: 'ignore',
		});
		child.once('error', reject);
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`browser exited with ${code}`)));
	});
}

class BridgeHostService {
	private readonly forwarded = new Map<number, { server: net.Server; hostPort: number }>();
	private readonly controlServer: http.Server;
	private scanTimer: NodeJS.Timeout | undefined;

	constructor(private readonly config: BridgeConfigFile) {
		this.controlServer = http.createServer((req, res) => void this.handleRequest(req, res));
	}

	async run() {
		await new Promise<void>((resolve, reject) => {
			this.controlServer.once('error', reject);
			this.controlServer.listen(this.config.controlPort, '0.0.0.0', () => resolve());
		});
		await this.scanPorts();
		this.scanTimer = setInterval(() => void this.scanPorts(), this.config.scanIntervalMs);
	}

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
		if (req.method !== 'POST' || req.url !== '/open') {
			res.statusCode = 404;
			res.end();
			return;
		}
		try {
			const body = await new Promise<string>((resolve, reject) => {
				let chunks = '';
				req.setEncoding('utf8');
				req.on('data', chunk => chunks += chunk);
				req.once('end', () => resolve(chunks));
				req.once('error', reject);
			});
			const contentType = req.headers['content-type'] || '';
			const payload = contentType.includes('application/json')
				? JSON.parse(body) as { url?: string; token?: string }
				: Object.fromEntries(new URLSearchParams(body).entries()) as { url?: string; token?: string };
			if (!payload.url || payload.token !== this.config.token) {
				res.statusCode = 403;
				res.end();
				return;
			}

			const rewritten = await this.rewriteLocalUrl(payload.url);
			await ensureOpen(rewritten);
			res.statusCode = 204;
			res.end();
		} catch {
			res.statusCode = 500;
			res.end();
		}
	}

	private async rewriteLocalUrl(rawUrl: string) {
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			return rawUrl;
		}
		if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
			return rawUrl;
		}
		const remotePort = Number(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));
		const hostPort = await this.ensureForward(remotePort);
		parsed.hostname = '127.0.0.1';
		parsed.port = String(hostPort);
		return parsed.toString();
	}

	private async scanPorts() {
		const result = await this.execInContainer('cat /proc/net/tcp /proc/net/tcp6');
		if (result.code !== 0) {
			await this.shutdown();
			return;
		}
		const ports = parseListeningPorts(result.stdout);
		for (const port of ports) {
			try {
				await this.ensureForward(port);
			} catch {
				// Ignore single-port failures so the bridge can keep serving others.
			}
		}
		for (const [port, forward] of [...this.forwarded.entries()]) {
			if (!ports.has(port)) {
				forward.server.close();
				this.forwarded.delete(port);
			}
		}
	}

	private async ensureForward(port: number) {
		const existing = this.forwarded.get(port);
		if (existing) {
			return existing.hostPort;
		}

		const server = net.createServer(socket => void this.handleSocket(port, socket));
		const hostPort = await new Promise<number>((resolve, reject) => {
			const listen = (candidatePort: number) => {
				server.once('error', err => {
					if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && candidatePort === port) {
						listen(0);
						return;
					}
					reject(err);
				});
				server.listen(candidatePort, '127.0.0.1', () => {
					const address = server.address();
					resolve(typeof address === 'object' && address ? address.port : port);
				});
			};
			listen(port);
		});
		this.forwarded.set(port, { server, hostPort });
		return hostPort;
	}

	private async handleSocket(port: number, socket: net.Socket) {
		const child = spawn(this.config.dockerPath, ['exec', '-i', this.config.containerId, '/bin/sh', '-lc', connectorCommand(port)], {
			env: this.config.dockerEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		if (!child.stdin || !child.stdout) {
			socket.destroy();
			child.kill();
			return;
		}
		socket.pipe(child.stdin);
		child.stdout.pipe(socket);
		const close = () => {
			socket.destroy();
			child.kill();
		};
		socket.once('error', close);
		socket.once('close', close);
		child.once('error', close);
		child.once('exit', () => socket.end());
	}

	private async execInContainer(command: string) {
		return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			const child = spawn(this.config.dockerPath, ['exec', this.config.containerId, '/bin/sh', '-lc', command], {
				env: this.config.dockerEnv,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', chunk => stdout += chunk);
			child.stderr?.on('data', chunk => stderr += chunk);
			child.once('exit', code => resolve({ code, stdout, stderr }));
			child.once('error', () => resolve({ code: 1, stdout, stderr }));
		});
	}

	private async shutdown() {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = undefined;
		}
		for (const { server } of this.forwarded.values()) {
			server.close();
		}
		this.forwarded.clear();
		this.controlServer.close();
	}
}

export async function runBridgeHostFromConfig(configPath: string) {
	const config = await readConfig(configPath);
	const service = new BridgeHostService(config);
	await service.run();
	await new Promise<void>(() => undefined);
}

export async function runBridgeSupervisorFromConfig(configPath: string) {
	const config = await readConfig(configPath);
	await fs.promises.writeFile(config.pidPath, `${process.pid}`);
	let child: ReturnType<typeof spawn> | undefined;
	let stopping = false;
	const stopChild = () => {
		if (child && !child.killed) {
			child.kill('SIGTERM');
		}
	};
	const shutdown = async () => {
		if (stopping) {
			return;
		}
		stopping = true;
		stopChild();
		await fs.promises.rm(config.pidPath, { force: true });
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown());
	process.on('SIGINT', () => void shutdown());

	while (!stopping) {
		if (!(await isContainerRunning(config))) {
			await shutdown();
			return;
		}
		child = spawn(process.execPath, [process.argv[1], 'bridge-host', '--config', configPath], {
			cwd: process.cwd(),
			stdio: 'ignore',
			env: process.env,
		});
		const exitCode = await new Promise<number | null>((resolve) => {
			child!.once('exit', code => resolve(code));
			child!.once('error', () => resolve(1));
		});
		child = undefined;
		if (stopping) {
			break;
		}
		if (!(await isContainerRunning(config))) {
			await shutdown();
			return;
		}
		await new Promise(resolve => setTimeout(resolve, exitCode === 0 ? 250 : 1000));
	}
}

export function bridgeLabels(session: BridgeSession | undefined): string[] {
	if (!session) {
		return [];
	}
	return [
		`${bridgeSessionLabel}=${session.sessionId}`,
		`${bridgeEnabledLabel}=true`,
	];
}

export function isBridgeAvailable() {
	return os.platform() === 'darwin';
}
