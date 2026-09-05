import path from 'node:path'
import {fileURLToPath} from 'node:url'
import Fastify from 'fastify'
import fastifyWs from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import helmet from '@fastify/helmet'

import {bootBitcoind, bitcoind} from './modules/bitcoind/bitcoind.js'
import {ensureDirs} from './lib/paths.js'
import routes from './routes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Ensure that the required data directories exist before we start
await ensureDirs()

// Start bitcoind without blocking server start
bootBitcoind().catch((error) => {
	bitcoind.setLastError(error as Error) // record for /status
	app.log.error(error, 'Bitcoind bootstrap failed.')
})

// Create the HTTP server and register the routes
const app = Fastify({logger: true})

// CSP
await app.register(helmet, {
	contentSecurityPolicy: {
		// We keep Helmet’s defaults and only add what's missing
		directives: {
			// Upgrade-insecure-requests is ignored on HTTP, so we omit it entirely
			upgradeInsecureRequests: null,
		},
	},
})

await app.register(fastifyWs)

// Detect dead WebSocket connections. Without this, a client whose network
// drops silently (no close frame) leaves a phantom connection that leaks
// listeners forever — especially on the /ws/bitcoind/exit endpoint which
// rarely sends data and would never trigger TCP failure detection.
const HEARTBEAT_MS = 30_000
const aliveClients = new WeakSet<import('ws').WebSocket>()

app.websocketServer.on('connection', (ws) => {
	aliveClients.add(ws)
	ws.on('pong', () => aliveClients.add(ws))
})

setInterval(() => {
	for (const ws of app.websocketServer.clients) {
		if (!aliveClients.has(ws)) {
			ws.terminate()
			continue
		}
		aliveClients.delete(ws)
		ws.ping()
	}
}, HEARTBEAT_MS)

// serve ui static files from dist/public in production
app.register(fastifyStatic, {
	root: path.join(__dirname, 'public'),
	wildcard: false, // do not serve index.html for all routes
})

await app.register(routes)

// SPA fallback is last to serve the UI routes
app.get('/*', (_, reply) => reply.sendFile('index.html'))

// Start the server
app
	.listen({port: 3000, host: '0.0.0.0'})
	.then((address) => app.log.info(`₿itcoin Node backend is running at ${address}`))
	.catch((error) => {
		app.log.error(`Failed to start server: ${error}`)
		process.exit(1)
	})

// Log unhandled rejections
process.on('unhandledRejection', (reason) => app.log.error({reason}, 'Unhandled rejection'))

// Graceful shutdown of bitcoind.
//
// The last line of defence, not the first. `bitcoind.stop()` is itself bounded
// and escalates to SIGKILL, so reaching this timer means something above it is
// wedged rather than merely slow. Either way the process must leave: when it did
// not, Docker held the container for the whole stop_grace_period and every app
// update looked like it had hung at 99%.
//
// Repeated signals are ignored rather than starting a second shutdown, since
// Docker sends SIGTERM once and then SIGKILLs, and a second pass would race the
// first over the same child.
// TODO: fix for dev: [tsx] Previous process hasn't exited yet. Force killing...
const SHUTDOWN_DEADLINE_MS = 11 * 60 * 1000
let shuttingDown = false

const shutdown = () => {
	if (shuttingDown) return
	shuttingDown = true

	const deadline = setTimeout(() => {
		app.log.error('Shutdown did not complete in time; exiting anyway')
		process.exit(1)
	}, SHUTDOWN_DEADLINE_MS)
	// Do not let the timer itself hold the event loop open.
	deadline.unref?.()

	bitcoind
		.stop()
		.catch((error) => app.log.error({error}, 'Error stopping bitcoind during shutdown'))
		.finally(() => {
			clearTimeout(deadline)
			process.exit(0)
		})
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
