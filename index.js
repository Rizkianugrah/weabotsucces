const P = require ('pino')
const { Boom } = require ('@hapi/boom')
const { default: makeWASocket, delay, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore, MessageRetryMap, useMultiFileAuthState, jidNormalizedUser } = require ('@adiwajshing/baileys')
const { serialize, WAConnection } = require ('./lib/simple')
const messageHandler = require('./killua')
const express = require('express')
const app = express()

const store = makeInMemoryStore({ logger: P().child({ level: 'silent', stream: 'store' }) })
store.readFromFile('./database/baileys_store_multi.json')
setInterval(() => {
	store.writeToFile('./database/baileys_store_multi.json')
}, 10_000)

global.api = (name, path = '/', query = {}, apikeyqueryname) => (name in config.APIs ? config.APIs[name] : name) + path + (query || apikeyqueryname ? '?' + new URLSearchParams(Object.entries({ ...query, ...(apikeyqueryname ? { [apikeyqueryname]: config.APIs.apikey } : {}) })) : '')

// start a connection
const connect = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('./database/baileys_auth_info')
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)
    class msgRetryCounterMap {
        MessageRetryMap = {}
    }
	let connOptions = {
        version,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
		connectTimeoutMs: 60000,
		keepAliveIntervalMs: 20000,
        msgRetryCounterMap,
    }
    const sock = new WAConnection(makeWASocket(connOptions))

    store.bind(sock.ev)

	sock.ev.on('chats.set', () => {
		console.log('got chats', store.chats.all())
	})
	
	sock.ev.on('contacts.set', () => {
		console.log('got contacts', Object.values(store.contacts))
	})

	const sendMessageWTyping = async(msg, jid) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	sock.ev.on('messages.upsert', async (chatUpdate) => {
        const m = serialize(sock, chatUpdate.messages[0])

        if (!m.message) return
        if (m.key && m.key.remoteJid == "status@broadcast") return

		if (config.options.autoRead) await sock.sendReadReceipt(m.key.remoteJid, m.key.participant, [m.key.id])
        messageHandler(sock,  m)
	})

	sock.ev.on('connection.update', async(update) => {
		const { connection, lastDisconnect } = update
		if(connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output.statusCode
			if (reason === DisconnectReason.badSession) { console.log(`Bad Session File, Please Delete Session and Scan Again`); sock.logout(); }
            else if (reason === DisconnectReason.connectionClosed) { console.log("Connection closed, reconnecting...."); connect(); }
            else if (reason === DisconnectReason.connectionLost) { console.log("Connection Lost from Server, reconnecting..."); connect(); }
            else if (reason === DisconnectReason.connectionReplaced) { console.log("Connection Replaced, Another New Session Opened, Please Close Current Session First"); sock.logout(); }
            else if (reason === DisconnectReason.loggedOut) { console.log(`Device Logged Out, Please Scan Again And Run.`); process.exit(); }
            else if (reason === DisconnectReason.restartRequired) { console.log("Restart Required, Restarting..."); connect(); }
            else if (reason === DisconnectReason.timedOut) { console.log("Connection TimedOut, Reconnecting..."); connect(); }
			else {
				console.log('Connection closed. You are logged out.')
			}
		}
	})

	// listen for when the auth credentials is updated
	sock.ev.on('creds.update', saveCreds)
	if (sock.user && sock.user?.id) sock.user.jid = jidNormalizedUser(sock.user?.id)

	return sock
}

app.get('/', async (req, res) => {
	const { version, isLatest } = await fetchLatestBaileysVersion()
	res.send(`using WA v${version.join('.')}, isLatest: ${isLatest}`)
})

const { PORT = 8080, LOCAL_ADDRESS = '0.0.0.0' } = process.env
app.listen(PORT, LOCAL_ADDRESS, () => {
    console.log('server activated listening at http://localhost:8080')
})

connect()
