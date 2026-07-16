/**
 * Adaptador Baileys — expõe a MESMA API que o index.js usava do whatsapp-web.js
 * (client.getChats, client.sendMessage, msg.reply, msg.downloadMedia, MessageMedia,
 *  chat.fetchMessages, chat.sendStateTyping, eventos qr/ready/message/disconnected).
 *
 * Motivo da migração: o whatsapp-web.js (puppeteer + WhatsApp Web) quebrou contra
 * a versão atual do WhatsApp Web (getChats/getChat estouravam com erro "r"). O
 * Baileys fala o protocolo direto (WebSocket), sem navegador, e é muito mais estável.
 */

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
  DisconnectReason,
  Browsers,
} from 'baileys'
import { EventEmitter } from 'events'

// Logger no-op (Baileys exige interface pino; não queremos poluir o log).
const silentLogger = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger },
}

/** Classe compatível com o MessageMedia do whatsapp-web.js. */
export class MessageMedia {
  constructor(mimetype, data, filename) {
    this.mimetype = mimetype || 'application/octet-stream'
    this.data = data || '' // base64
    this.filename = filename || null
  }
}

// c.us (formato antigo do wwebjs) -> s.whatsapp.net (Baileys). Mantém g.us/lid.
function toJid(dest) {
  const s = String(dest || '')
  if (s.endsWith('@c.us')) return s.replace('@c.us', '@s.whatsapp.net')
  if (s.includes('@')) return s
  const d = s.replace(/\D/g, '')
  return d ? `${d}@s.whatsapp.net` : s
}

function soDigitos(s) {
  return String(s || '').replace(/\D+/g, '')
}

// Desembrulha wrappers (ephemeral / viewOnce) e devolve o "message" real.
function unwrap(message) {
  let m = message
  for (let i = 0; i < 4 && m; i++) {
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue }
    if (m.viewOnceMessage) { m = m.viewOnceMessage.message; continue }
    if (m.viewOnceMessageV2) { m = m.viewOnceMessageV2.message; continue }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue }
    break
  }
  return m || {}
}

function extrairTexto(message) {
  const m = unwrap(message)
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  )
}

// Tipo no estilo wwebjs: 'chat'|'ptt'|'audio'|'video'|'image'|'document'|'sticker'
function tipoMsg(message) {
  const m = unwrap(message)
  if (m.imageMessage) return 'image'
  if (m.videoMessage) return 'video'
  if (m.audioMessage) return m.audioMessage.ptt ? 'ptt' : 'audio'
  if (m.documentMessage) return 'document'
  if (m.stickerMessage) return 'sticker'
  return 'chat'
}

function temMidia(message) {
  const m = unwrap(message)
  return !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage)
}

function nomeArquivo(message) {
  const m = unwrap(message)
  return m.documentMessage?.fileName || null
}

function mimeMidia(message) {
  const m = unwrap(message)
  const node = m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage
  return node?.mimetype || ''
}

function contextInfo(message) {
  const m = unwrap(message)
  const node = m.extendedTextMessage || m.imageMessage || m.videoMessage || m.documentMessage || m.audioMessage
  return node?.contextInfo || {}
}

/** Cria o "client" compatível. opts: { sessionDir } */
export function createClient(opts = {}) {
  const sessionDir = opts.sessionDir || './sessao-baileys'
  const client = new EventEmitter()

  let sock = null
  let pairNumber = null // se setado antes de conectar, tenta pairing code
  let pairRequested = false
  const msgStore = new Map() // jid -> array de mensagens cruas (para fetchMessages)
  const groupCache = new Map() // jid -> subject (nome do grupo)

  function guardar(jid, raw) {
    if (!jid) return
    let arr = msgStore.get(jid)
    if (!arr) { arr = []; msgStore.set(jid, arr) }
    arr.push(raw)
    if (arr.length > 800) arr.splice(0, arr.length - 800)
  }

  // ---- envio (lê o sock atual; sobrevive a reconexões) ----
  async function enviar(dest, content, sendOpts = {}) {
    const jid = toJid(dest instanceof Object && dest._serialized ? dest._serialized : dest)
    let payload
    if (content instanceof MessageMedia) {
      const buf = Buffer.from(content.data, 'base64')
      const mt = content.mimetype || ''
      if (mt.startsWith('image/')) payload = { image: buf, caption: sendOpts.caption }
      else if (mt.startsWith('video/')) payload = { video: buf, caption: sendOpts.caption }
      else if (mt.startsWith('audio/')) payload = { audio: buf, mimetype: mt, ptt: false }
      else payload = { document: buf, mimetype: mt || 'application/octet-stream', fileName: content.filename || 'arquivo', caption: sendOpts.caption }
    } else {
      payload = { text: String(content ?? '') }
    }
    const o = {}
    if (sendOpts.quoted) o.quoted = sendOpts.quoted
    return sock.sendMessage(jid, payload, o)
  }

  // ---- objetos "chat" e "message" no formato wwebjs ----
  function fazerChat(jid) {
    const isGroup = String(jid).endsWith('@g.us')
    return {
      isGroup,
      name: isGroup ? (groupCache.get(jid) || '') : '',
      id: { _serialized: jid },
      async fetchMessages({ limit = 50 } = {}) {
        const arr = msgStore.get(jid) || []
        return arr.slice(-limit).map((r) => fazerMsg(r))
      },
      async sendStateTyping() {
        try { await sock.sendPresenceUpdate('composing', jid) } catch {}
      },
      async sendMessage(content, o = {}) { return enviar(jid, content, o) },
    }
  }

  function fazerMsg(raw) {
    const key = raw.key || {}
    const remoteJid = key.remoteJid
    const isGroup = String(remoteJid).endsWith('@g.us')
    const message = raw.message || {}
    const ctx = contextInfo(message)
    const meJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null

    const msg = {
      _raw: raw,
      from: remoteJid,
      to: isGroup ? remoteJid : meJid, // privado: destino é o próprio bot
      author: isGroup ? (key.participant || '') : (key.fromMe ? meJid : remoteJid),
      fromMe: !!key.fromMe,
      body: extrairTexto(message),
      type: tipoMsg(message),
      hasMedia: temMidia(message),
      timestamp: Number(raw.messageTimestamp) || Math.floor(Date.now() / 1000),
      id: { _serialized: key.id, id: key.id },
      mentionedIds: ctx.mentionedJid || [],
      pushName: raw.pushName || '',
      hasQuotedMsg: !!ctx.quotedMessage,

      async getChat() { return fazerChat(remoteJid) },
      async getContact() {
        const numJid = isGroup ? (key.participant || remoteJid) : remoteJid
        const num = soDigitos((numJid || '').split('@')[0].split(':')[0])
        return { pushname: raw.pushName || '', name: raw.pushName || '', number: num, id: { user: num, _serialized: numJid } }
      },
      async getQuotedMessage() {
        if (!ctx.quotedMessage) return null
        const qraw = {
          key: {
            remoteJid,
            id: ctx.stanzaId,
            participant: ctx.participant,
            fromMe: false,
          },
          message: ctx.quotedMessage,
          messageTimestamp: msg.timestamp,
          pushName: '',
        }
        return fazerMsg(qraw)
      },
      async downloadMedia() {
        try {
          const buf = await downloadMediaMessage(
            raw, 'buffer', {},
            { logger: silentLogger, reuploadRequest: sock.updateMediaMessage },
          )
          return new MessageMedia(mimeMidia(message), Buffer.from(buf).toString('base64'), nomeArquivo(message))
        } catch (e) {
          console.warn('⚠️ Falha ao baixar mídia (baileys):', e.message)
          return null
        }
      },
      async reply(text) { return enviar(remoteJid, text, { quoted: raw }) },
    }
    return msg
  }

  // ---- API do client usada pelo index.js ----
  client.info = null
  client.pupBrowser = null // Baileys não tem navegador (screenshots desativados)

  client.getChats = async function () {
    try {
      const grupos = await sock.groupFetchAllParticipating()
      const chats = []
      for (const [jid, meta] of Object.entries(grupos || {})) {
        groupCache.set(jid, meta.subject || '')
        chats.push(fazerChat(jid))
      }
      return chats
    } catch (e) {
      console.warn('⚠️ getChats (baileys) falhou:', e.message)
      return []
    }
  }

  client.sendMessage = async function (dest, content, o = {}) {
    return enviar(dest, content, o)
  }

  client.getContactById = async function (jid) {
    const num = soDigitos((String(jid) || '').split('@')[0].split(':')[0])
    return { number: num, id: { user: num, _serialized: jid } }
  }

  client.requestPairingCode = async function (numero) {
    return sock.requestPairingCode(soDigitos(numero))
  }

  // Permite ao index.js pedir pairing por número (em vez de QR) antes de conectar.
  client.setPairNumber = function (n) { pairNumber = soDigitos(n) || null }

  // ---- conexão (com reconexão automática) ----
  async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    let version
    try { ({ version } = await fetchLatestBaileysVersion()) } catch {}

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      logger: silentLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u

      if (qr) {
        // Pairing por número (se configurado) na primeira vez; senão, QR.
        if (pairNumber && !pairRequested && !sock.authState.creds.registered) {
          pairRequested = true
          try {
            const code = await sock.requestPairingCode(pairNumber)
            client.emit('pairing-code', code, pairNumber)
            return
          } catch (e) {
            console.error('⚠️ Falha ao pedir pairing code:', e.message, '— caindo pro QR.')
          }
        }
        client.emit('qr', qr)
      }

      if (connection === 'open') {
        const meJid = jidNormalizedUser(sock.user.id)
        const user = meJid.split('@')[0]
        const lidJid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null
        client.info = {
          wid: { _serialized: meJid, user },
          me: { _serialized: meJid },
          lid: lidJid ? { _serialized: lidJid, user: lidJid.split('@')[0] } : { _serialized: null, user: null },
        }
        client.emit('authenticated')
        client.emit('ready')
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        client.emit('disconnected', loggedOut ? 'LOGGED_OUT' : (code || 'close'))
        if (!loggedOut) {
          setTimeout(() => start().catch((e) => console.error('Falha ao reconectar:', e.message)), 3000)
        } else {
          console.error('❌ Sessão desconectada (logout). Apague a pasta da sessão e escaneie o QR de novo.')
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const raw of messages) {
        if (!raw.message) continue
        const jid = raw.key?.remoteJid
        if (!jid || jid === 'status@broadcast') continue
        guardar(jid, raw)
        // Só emite mensagens NOVAS e que não são do próprio bot.
        if (type !== 'notify' || raw.key?.fromMe) continue
        try { client.emit('message', fazerMsg(raw)) } catch (e) { console.error('Erro ao montar msg:', e.message) }
      }
    })

    // Mantém o cache de nomes de grupo atualizado.
    sock.ev.on('groups.update', async () => {
      try {
        const g = await sock.groupFetchAllParticipating()
        for (const [j, m] of Object.entries(g || {})) groupCache.set(j, m.subject || '')
      } catch {}
    })
    sock.ev.on('groups.upsert', (gs) => {
      for (const g of gs || []) groupCache.set(g.id, g.subject || '')
    })
  }

  client.initialize = function () {
    start().catch((e) => console.error('❌ Falha ao iniciar Baileys:', e.message))
  }

  return client
}
