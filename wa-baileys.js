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
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs'

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

  // Cache de grupos PERSISTENTE. O groupFetchAllParticipating() do WhatsApp é
  // pesado e leva rate-overlimit se chamado demais — então cacheamos em disco,
  // atualizamos no máximo a cada 5 min, e aprendemos o nome quando chega msg.
  const GRUPOS_FILE = opts.gruposFile || './grupos-cache.json'
  try {
    if (existsSync(GRUPOS_FILE)) {
      for (const [j, s] of Object.entries(JSON.parse(readFileSync(GRUPOS_FILE, 'utf8')) || {})) groupCache.set(j, s)
    }
  } catch {}
  function salvarGrupos() {
    try { writeFileSync(GRUPOS_FILE, JSON.stringify(Object.fromEntries(groupCache))) } catch {}
  }
  let ultimoFetchGrupos = 0
  let fetchGruposEmAndamento = false
  async function garantirGrupos(forcar = false) {
    if (!sock) return
    const agora = Date.now()
    if (!forcar && agora - ultimoFetchGrupos < 5 * 60 * 1000) return
    if (fetchGruposEmAndamento) return
    fetchGruposEmAndamento = true
    try {
      const g = await sock.groupFetchAllParticipating()
      if (g && Object.keys(g).length) {
        for (const [j, m] of Object.entries(g)) groupCache.set(j, m.subject || '')
        salvarGrupos()
        ultimoFetchGrupos = agora
      }
    } catch {
      // rate-overlimit/etc — mantém o cache e tenta mais tarde
    } finally {
      fetchGruposEmAndamento = false
    }
  }
  // Aprende o nome de UM grupo (chamada leve) quando chega mensagem dele.
  function aprenderGrupo(jid) {
    if (!jid || !String(jid).endsWith('@g.us') || groupCache.has(jid) || !sock) return
    sock.groupMetadata(jid).then((m) => {
      if (m?.subject) { groupCache.set(jid, m.subject); salvarGrupos() }
    }).catch(() => {})
  }

  // Histórico persistente em disco (JSONL por dia) — permite resumo do dia
  // inteiro mesmo após reinício. Cada linha: {jid, raw}.
  const HIST_DIR = opts.histDir || './historico'
  const HIST_DIAS = Number(opts.histDias || 8) // mantém ~8 dias
  try { if (!existsSync(HIST_DIR)) mkdirSync(HIST_DIR, { recursive: true }) } catch {}

  function dataLocal(tsSec) {
    const d = new Date((Number(tsSec) || Math.floor(Date.now() / 1000)) * 1000)
    return d.toLocaleDateString('en-CA') // YYYY-MM-DD no fuso do processo
  }

  function persistir(jid, raw) {
    try {
      const dia = dataLocal(raw.messageTimestamp)
      appendFileSync(`${HIST_DIR}/${dia}.jsonl`, JSON.stringify({ jid, raw }) + '\n')
    } catch {}
  }

  function limparHistoricoAntigo() {
    try {
      const arquivos = readdirSync(HIST_DIR).filter((f) => f.endsWith('.jsonl')).sort()
      while (arquivos.length > HIST_DIAS) {
        const velho = arquivos.shift()
        try { unlinkSync(`${HIST_DIR}/${velho}`) } catch {}
      }
    } catch {}
  }
  limparHistoricoAntigo()

  function guardar(jid, raw) {
    if (!jid) return
    let arr = msgStore.get(jid)
    if (!arr) { arr = []; msgStore.set(jid, arr) }
    arr.push(raw)
    if (arr.length > 800) arr.splice(0, arr.length - 800)
    persistir(jid, raw)
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
    // Sem cache ainda: força UMA busca. Com cache: usa o que tem e atualiza
    // em segundo plano (não bloqueia nem estoura rate-limit).
    if (!groupCache.size) await garantirGrupos(true)
    else garantirGrupos().catch(() => {})
    return [...groupCache.entries()]
      .filter(([j]) => String(j).endsWith('@g.us'))
      .map(([j]) => fazerChat(j))
  }

  client.sendMessage = async function (dest, content, o = {}) {
    return enviar(dest, content, o)
  }

  // Mensagens de um chat entre dois instantes (Unix segundos). Lê o histórico
  // em disco (dias abrangidos) + o que está em memória, deduplicando por id.
  // Retorna objetos "message" (com downloadMedia/getContact) ordenados por tempo.
  client.mensagensDoPeriodo = async function (jid, iniTs, fimTs) {
    const porId = new Map()
    const considerar = (raw) => {
      const ts = Number(raw?.messageTimestamp) || 0
      if (ts < iniTs || ts > fimTs) return
      const id = raw?.key?.id
      if (!id || porId.has(id)) return
      porId.set(id, raw)
    }
    // Dias abrangidos (YYYY-MM-DD) do início ao fim.
    const dias = new Set()
    for (let t = iniTs; t <= fimTs + 86400; t += 43200) {
      dias.add(new Date(t * 1000).toLocaleDateString('en-CA'))
    }
    for (const dia of dias) {
      try {
        const txt = readFileSync(`${HIST_DIR}/${dia}.jsonl`, 'utf8')
        for (const linha of txt.split('\n')) {
          if (!linha.trim()) continue
          let obj
          try { obj = JSON.parse(linha) } catch { continue }
          if (obj.jid === jid && obj.raw) considerar(obj.raw)
        }
      } catch {}
    }
    // Complementa com o que está só em memória (ainda não relido).
    for (const raw of (msgStore.get(jid) || [])) considerar(raw)

    return [...porId.values()]
      .sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0))
      .map((r) => fazerMsg(r))
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

  client.reconnect = async function () {
    if (!sock) {
      await start()
      return
    }
    sock.end(new Error('Reconexão solicitada pelo NexoK'))
  }

  client.startPairing = async function (numero) {
    const normalized = soDigitos(numero)
    if (normalized.length < 10 || normalized.length > 15) throw new Error('Telefone inválido para pareamento.')

    pairNumber = normalized
    pairRequested = false
    try {
      if (sock) await sock.logout()
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 800))
    rmSync(sessionDir, { recursive: true, force: true })
    mkdirSync(sessionDir, { recursive: true })
    client.info = null
    await start()
  }

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
      syncFullHistory: true, // puxa o histórico recente ao conectar (p/ resumo do dia)
      shouldSyncHistoryMessage: () => true,
    })

    sock.ev.on('creds.update', saveCreds)

    // Sincronismo de histórico do WhatsApp (ao conectar/pós-pareamento):
    // guarda as mensagens no histórico persistente SEM reprocessar como demanda,
    // e aprende os nomes dos grupos. É o que permite "resumo do dia" pegar
    // mensagens anteriores ao boot.
    sock.ev.on('messaging-history.set', ({ chats, messages }) => {
      try {
        for (const c of chats || []) {
          if (c?.id && String(c.id).endsWith('@g.us') && (c.name || c.subject)) {
            groupCache.set(c.id, c.name || c.subject)
          }
        }
        if (chats?.length) salvarGrupos()
        let n = 0
        for (const raw of messages || []) {
          const jid = raw?.key?.remoteJid
          if (!raw?.message || !jid || jid === 'status@broadcast') continue
          guardar(jid, raw)
          n++
        }
        if (n) console.log(`🗂️  Histórico sincronizado: ${n} mensagem(ns), ${(chats || []).length} chat(s).`)
      } catch {}
    })

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
        // Atualiza o cache de grupos uma vez, com folga (evita rate-overlimit
        // logo após conectar). Se falhar, tenta de novo no próximo getChats.
        setTimeout(() => garantirGrupos(true).catch(() => {}), 12000)
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
        aprenderGrupo(jid) // aprende o nome do grupo se ainda não conhece
        // Só emite mensagens NOVAS e que não são do próprio bot.
        if (type !== 'notify' || raw.key?.fromMe) continue
        try { client.emit('message', fazerMsg(raw)) } catch (e) { console.error('Erro ao montar msg:', e.message) }
      }
    })

    // Mantém o cache de nomes de grupo atualizado.
    sock.ev.on('groups.update', (gs) => {
      let mudou = false
      for (const g of gs || []) {
        if (g?.id && g.subject) { groupCache.set(g.id, g.subject); mudou = true }
      }
      if (mudou) salvarGrupos()
    })
    sock.ev.on('groups.upsert', (gs) => {
      for (const g of gs || []) if (g?.id) groupCache.set(g.id, g.subject || '')
      salvarGrupos()
    })
  }

  client.initialize = function () {
    start().catch((e) => console.error('❌ Falha ao iniciar Baileys:', e.message))
  }

  return client
}
