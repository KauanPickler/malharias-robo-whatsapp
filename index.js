/**
 * Robô do WhatsApp — Malharias Hub
 *
 * Escuta os grupos do WhatsApp (somente LEITURA, nunca envia) e manda cada
 * mensagem para o hub, que classifica com IA e registra como demanda.
 *
 * ⚠️ AVISO: usa whatsapp-web.js (não-oficial). Isso viola os Termos do WhatsApp
 * e o número PODE ser banido. Use SEMPRE um chip dedicado, nunca o pessoal.
 *
 * Rodar:  npm install  &&  npm start
 * Na 1ª vez, escaneie o QR code que aparece no terminal com o chip dedicado.
 */

import pkg from 'whatsapp-web.js'
const { Client, LocalAuth } = pkg
import qrcode from 'qrcode-terminal'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'

// Guarda os chats dos admins (quem comanda o bot) para enviar avisos.
// Persiste em arquivo pra sobreviver a reinício.
const ADMIN_FILE = './admin-chats.json'
let adminChats = new Set()
try {
  if (existsSync(ADMIN_FILE)) adminChats = new Set(JSON.parse(readFileSync(ADMIN_FILE, 'utf8')))
} catch {}
function lembrarAdmin(id) {
  if (id && !adminChats.has(id)) {
    adminChats.add(id)
    try {
      writeFileSync(ADMIN_FILE, JSON.stringify([...adminChats]))
    } catch {}
  }
}

// IDs do próprio bot (número e @lid). Usado pra detectar quando marcam o bot
// num grupo. Aprende o @lid pelas mensagens privadas (destino = o próprio bot).
const BOTIDS_FILE = './bot-ids.json'
let botIds = new Set()
try {
  if (existsSync(BOTIDS_FILE)) botIds = new Set(JSON.parse(readFileSync(BOTIDS_FILE, 'utf8')))
} catch {}
function lembrarBotId(raw) {
  const d = String(raw || '').replace(/\D/g, '')
  if (d.length >= 8 && !botIds.has(d)) {
    botIds.add(d)
    try {
      writeFileSync(BOTIDS_FILE, JSON.stringify([...botIds]))
    } catch {}
  }
}

let config
try {
  config = (await import('./config.js')).default
} catch {
  console.error('\n❌ Arquivo config.js não encontrado.')
  console.error('   Copie config.example.js para config.js e preencha o token.\n')
  process.exit(1)
}

if (!config.ingestToken || config.ingestToken.includes('COLE_AQUI')) {
  console.error('\n❌ Configure o "ingestToken" em config.js (gere no hub: Robô & IA).\n')
  process.exit(1)
}

// ---- Config remota (vinda do hub: aba "Robô & IA") ----
// O config.js local só precisa de hubUrl + ingestToken. Mapeamento de grupos,
// flags de transcrição etc. são gerenciados no painel e buscados aqui.
let remote = {}

// Auto-update: baseline do "update_nonce" que vem do hub. Definido no boot com o
// valor atual (então o boot nunca dispara). Quando o admin clica "Atualizar robô"
// no painel, o nonce muda -> o robô puxa o código e reinicia sozinho.
let updateBaseline = null
// Reinício remoto: baseline do "restart_nonce". Botão "Reiniciar robô" no painel.
let restartBaseline = null

// Estado do robô (para o heartbeat / painel).
const bootTime = new Date().toISOString()
const VERSION = '1.5.0'
let whatsappReady = false
let botId = null // id do próprio bot no WhatsApp (preenchido no 'ready')

/** Envia "sinal de vida" ao hub para o painel mostrar o estado do robô. */
async function heartbeatLoop() {
  try {
    await fetch(`${config.hubUrl}/api/robo/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: config.ingestToken,
        uptime: Math.round(process.uptime()),
        started_at: bootTime,
        whatsapp: whatsappReady,
        version: VERSION,
      }),
    })
  } catch {}
  setTimeout(heartbeatLoop, 60000) // a cada 60s
}

/**
 * Dispara o auto-update em um processo separado (detached), pra ele sobreviver
 * ao reinício do próprio robô. Faz: git pull + npm install + pm2 restart.
 */
function rodarUpdate() {
  try {
    const cmd = 'git pull --ff-only && PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund && pm2 restart malharias-robo'
    const child = spawn('bash', ['-lc', cmd], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (e) {
    console.error('❌ Falha ao iniciar o auto-update:', e.message)
  }
}

/** Checa os nonces de atualização/reinício vindos do hub; age se mudarem. */
async function autoUpdateLoop() {
  try {
    const upd = remote?.update_nonce ?? null
    if (upd !== null && String(upd) !== String(updateBaseline)) {
      updateBaseline = upd // marca como aplicado (evita repetir se o restart demorar)
      console.log('🔄 Atualização solicitada pelo hub — git pull + npm install + restart...')
      rodarUpdate()
    }
    const rst = remote?.restart_nonce ?? null
    if (rst !== null && String(rst) !== String(restartBaseline)) {
      restartBaseline = rst
      console.log('♻️ Reinício solicitado pelo hub — saindo para o pm2 reerguer...')
      setTimeout(() => process.exit(0), 500) // pm2 (autorestart) sobe de novo
    }
  } catch {}
  setTimeout(autoUpdateLoop, 30000) // checa a cada 30s
}

async function carregarConfigRemota() {
  try {
    const res = await fetch(`${config.hubUrl}/api/robo/config?token=${encodeURIComponent(config.ingestToken)}`)
    if (!res.ok) {
      console.warn(`⚠️ Não consegui buscar config do hub (HTTP ${res.status}). Usando config.js local.`)
      return
    }
    remote = await res.json()
    const nGrupos = Object.keys(remote.grupo_para_sistema || {}).length
    console.log(`⚙️  Config do hub carregada (${nGrupos} grupo(s) mapeado(s)).`)
  } catch (e) {
    console.warn('⚠️ Falha ao buscar config do hub:', e.message, '— usando config.js local.')
  }
}

/** Config efetiva: o hub manda; o config.js é fallback. */
function cfg() {
  return {
    apenasGrupos: remote.apenas_grupos ?? config.apenasGrupos ?? true,
    transcreverAudio: remote.transcrever_audio ?? config.transcreverAudio ?? true,
    transcreverVideo: remote.transcrever_video ?? config.transcreverVideo ?? false,
    transcreverImagem: remote.transcrever_imagem ?? config.transcreverImagem ?? false,
    maxMidiaMb: remote.max_midia_mb ?? config.maxMidiaMb ?? 16,
    ignorarGrupos: remote.ignorar_grupos ?? config.ignorarGrupos ?? [],
    grupoParaSistema: remote.grupo_para_sistema ?? config.grupoParaSistema ?? {},
    controleNumeros: remote.controle_numeros ?? config.controleNumeros ?? [],
    notificarDemandas: remote.notificar_demandas ?? config.notificarDemandas ?? true,
    somenteMapeados: remote.somente_mapeados ?? config.somenteMapeados ?? false,
  }
}

/** Reporta ao hub a lista de grupos que o bot enxerga (para selecionar no painel). */
async function reportarGrupos() {
  try {
    if (!whatsappReady) return
    const chats = await client.getChats()
    const grupos = chats.filter((c) => c.isGroup).map((c) => c.name).filter(Boolean)
    await fetch(`${config.hubUrl}/api/robo/grupos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.ingestToken, grupos }),
    })
  } catch (e) {
    console.warn('⚠️ Falha ao reportar grupos:', e.message)
  }
}

/** Só dígitos de um número/ID do WhatsApp (ex: "55479...@c.us" -> "55479..."). */
function soDigitos(s) {
  return String(s || '').replace(/\D+/g, '')
}

/** O número (ou ID) é de alguém autorizado a comandar o bot? */
function numeroAutorizado(fromNum) {
  const autorizados = (cfg().controleNumeros || []).map(soDigitos).filter(Boolean)
  if (!autorizados.length) return false
  // Compara pelos últimos 8 dígitos (ignora 55/DDD e o 9º dígito que o WhatsApp
  // às vezes acrescenta/remove nos números do Brasil; serve também p/ o @lid).
  const tail = (s) => String(s).slice(-8)
  return autorizados.some((n) => tail(n).length === 8 && tail(n) === tail(fromNum))
}

/** Comando privado de número autorizado? */
function ehComando(fromNum, chat) {
  return !chat.isGroup && numeroAutorizado(fromNum)
}

/** O bot foi marcado (@menção) nesta mensagem? Resolve o lid -> número do bot. */
async function botFoiMencionado(msg, texto) {
  const t = (texto || '').trim()
  // Menção textual EXPLÍCITA "@bot" (quando não vira menção real do WhatsApp).
  // OBS: NÃO tratamos "qualquer @" como menção — senão marcar outra pessoa no
  // grupo fazia o bot achar que era com ele.
  if (/@bot\b/i.test(t)) return true
  // Menção REAL do WhatsApp: algum dos mentionedIds tem que ser o próprio bot.
  const ids = msg.mentionedIds || []
  if (!ids.length) return false
  const botTails = [...botIds].map((b) => b.slice(-8)).filter(Boolean)
  if (!botTails.length) return false
  for (const raw of ids) {
    const sid = typeof raw === 'string' ? raw : raw?._serialized || String(raw)
    // match direto (caso o mention seja pelo número do bot)
    if (botTails.includes(soDigitos(sid).slice(-8))) return true
    // resolve o contato da menção e compara o número com o do bot
    try {
      const c = await client.getContactById(sid)
      const num = soDigitos(String(c?.number || c?.id?.user || ''))
      if (num && botTails.includes(num.slice(-8))) {
        lembrarBotId(soDigitos(sid)) // memoriza o lid do bot p/ próximas vezes
        return true
      }
    } catch {}
  }
  return false
}

/** Resume um grupo: busca as mensagens recentes e pede o resumo ao hub. */
async function resumirGrupo(nomeGrupo) {
  const chats = await client.getChats()
  const grupo = chats.find(
    (c) => c.isGroup && (c.name || '').toLowerCase().includes(nomeGrupo.toLowerCase()),
  )
  if (!grupo) {
    return `❌ Não achei um grupo com "${nomeGrupo}". Mande *grupos* para ver a lista.`
  }

  const msgs = await grupo.fetchMessages({ limit: 80 })
  const linhas = []
  for (const m of msgs) {
    let nome = m.author || m.from || ''
    try {
      const c = await m.getContact()
      nome = c.pushname || c.name || c.number || nome
    } catch {}
    const corpo = (m.body || '').trim() || (m.hasMedia ? '[mídia]' : '')
    if (corpo) linhas.push(`${nome}: ${corpo}`)
  }

  if (!linhas.length) return `Não há mensagens recentes em "${grupo.name}".`

  try {
    const res = await fetch(`${config.hubUrl}/api/robo/resumo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.ingestToken, grupo: grupo.name, texto: linhas.join('\n') }),
    })
    const data = await res.json().catch(() => ({}))
    return `📋 *Resumo — ${grupo.name}*\n\n${data.resumo || 'Não consegui resumir agora.'}`
  } catch (e) {
    return `⚠️ Erro ao resumir: ${e.message}`
  }
}

/** Lista os grupos que o bot enxerga. */
async function listarGrupos() {
  const chats = await client.getChats()
  const grupos = chats.filter((c) => c.isGroup).map((c) => '• ' + c.name)
  return grupos.length ? `*Grupos disponíveis:*\n${grupos.slice(0, 60).join('\n')}` : 'Nenhum grupo encontrado.'
}

/** Transcreve um áudio recebido (comando por voz) usando o hub. */
async function transcreverAudio(msg) {
  try {
    const media = await msg.downloadMedia()
    if (!media?.data) return ''
    const res = await fetch(`${config.hubUrl}/api/robo/transcrever`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.ingestToken, media_base64: media.data, media_mime: media.mimetype || '', media_type: 'audio' }),
    })
    const data = await res.json().catch(() => ({}))
    return (data.texto || '').trim()
  } catch (e) {
    console.warn('⚠️ Falha ao transcrever áudio:', e.message)
    return ''
  }
}

/** Lê um documento/imagem (PDF, Nota Fiscal, boleto...) e extrai os campos via IA. */
async function lerDocumento(msg) {
  try {
    await msg.reply('📄 Lendo o documento e extraindo os campos...')
    const media = await msg.downloadMedia()
    if (!media?.data) return msg.reply('⚠️ Não consegui baixar o documento.')
    const res = await fetch(`${config.hubUrl}/api/robo/documento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: config.ingestToken,
        media_base64: media.data,
        media_mime: media.mimetype || '',
        filename: media.filename || '',
      }),
    })
    const data = await res.json().catch(() => ({}))
    return msg.reply(data.texto || '⚠️ Não consegui ler o documento agora.')
  } catch (e) {
    return msg.reply('⚠️ Erro ao ler o documento: ' + e.message)
  }
}

/** Interpreta e executa um comando recebido por mensagem privada. */
async function tratarComando(msg, textoOverride = null) {
  const texto = (textoOverride ?? msg.body ?? '').trim()
  const lower = texto.toLowerCase()

  if (lower === 'ajuda' || lower === '/ajuda' || lower === 'help' || lower === 'menu') {
    return msg.reply(
      '🤖 *Posso te ajudar com:*\n' +
        '• *resumo do grupo NOME* — resumo das mensagens do grupo\n' +
        '• *grupos* — lista os grupos disponíveis\n' +
        '• *versão* — mostra a versão do robô\n' +
        '• *reset* — limpa a conversa se eu travar\n\n' +
        'E qualquer coisa do sistema, é só pedir. Ex:\n' +
        '• "status das máquinas da JM"\n' +
        '• "quais demandas estão abertas?"\n' +
        '• "abre uma demanda: trocar placa da máquina 5 na JM"\n' +
        '• "como tá a fábrica?"\n' +
        '• "faz o deploy da JM"',
    )
  }

  if (lower === 'grupos' || lower === '/grupos') {
    return msg.reply(await listarGrupos())
  }

  // Versão do robô — pra conferir se o Raspberry está rodando o código atualizado.
  if (lower.includes('versão') || lower.includes('versao') || lower.includes('version')) {
    const up = Math.round(process.uptime())
    const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60)
    return msg.reply(`🤖 *Robô Malharias*\nVersão: *${VERSION}*\nNo ar há ${h}h ${m}m`)
  }

  // "resumo do grupo X" / "/resumo X" / "resumir grupo X"
  const idx = lower.indexOf('grupo')
  let nome = null
  if (idx >= 0) nome = texto.slice(idx + 5).trim()
  else if (lower.startsWith('/resumo')) nome = texto.slice(7).trim()
  else if (lower.startsWith('resumo')) nome = texto.slice(6).trim()

  if (nome !== null) {
    if (!nome) return msg.reply('Qual grupo? Ex: *resumo do grupo Operação JM*. (ou mande *grupos*)')
    await msg.reply('⏳ Lendo o grupo e resumindo...')
    return msg.reply(await resumirGrupo(nome))
  }

  // Qualquer outra coisa vai para a IA do hub (mesma do chat do painel):
  // ela pode ver máquinas, criar demanda, fazer deploy, etc.
  return askAssistente(msg, texto)
}

/**
 * Avisa o(s) admin(s) no WhatsApp quando uma nova demanda é registrada.
 * Consulta o hub a cada 60s e envia o resumo (classificado pela IA).
 */
async function notificarDemandasLoop() {
  try {
    const c = cfg()
    const admins = (c.controleNumeros || []).map(soDigitos).filter(Boolean)
    // Destinos: chats de admin já conhecidos (funciona com @lid) ou, como
    // fallback, os números configurados no formato @c.us.
    const destinos = adminChats.size ? [...adminChats] : admins.map((n) => `${n}@c.us`)

    if (c.notificarDemandas !== false && destinos.length) {
      const res = await fetch(
        `${config.hubUrl}/api/robo/demandas-novas?token=${encodeURIComponent(config.ingestToken)}`,
      )
      if (res.ok) {
        const data = await res.json()
        for (const d of data.demandas || []) {
          const urg = d.urgencia === 'alta' ? '🔴' : d.urgencia === 'media' ? '🟡' : '🟢'
          const linhas = [
            `🆕 *Nova demanda* ${urg} ${d.tipo}`,
            `*Sistema:* ${d.sistema}`,
          ]
          if (d.maquina) linhas.push(`*Máquina:* ${d.maquina}`)
          linhas.push('', d.resumo)
          if (d.autor || d.grupo) linhas.push('', `_${[d.autor, d.grupo].filter(Boolean).join(' · ')}_`)
          if (d.tem_imagem) linhas.push('📎 (tem imagem no painel)')
          linhas.push('', `Responda aqui pra agir (ex: "marca a demanda ${d.id} como resolvida").`)
          const texto = linhas.join('\n')

          for (const dest of destinos) {
            try {
              await client.sendMessage(dest, texto)
            } catch (e) {
              console.warn('⚠️ Falha ao avisar admin:', e.message)
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Erro no aviso de demandas:', e.message)
  }

  setTimeout(notificarDemandasLoop, 60000) // a cada 60s
}

/** Envia um texto num grupo (pelo nome). */
async function enviarNoGrupo(nome, texto) {
  try {
    const chats = await client.getChats()
    const alvo = nome.toLowerCase()
    const g =
      chats.find((c) => c.isGroup && (c.name || '').toLowerCase() === alvo) ||
      chats.find((c) => c.isGroup && (c.name || '').toLowerCase().includes(alvo))
    if (g) await client.sendMessage(g.id._serialized, texto)
  } catch (e) {
    console.warn('⚠️ Falha ao enviar no grupo:', e.message)
  }
}

/**
 * Busca avisos do hub (alertas, resumo, lembretes, "resolvido no grupo") e
 * envia no WhatsApp — pro admin (privado) ou no grupo indicado.
 */
async function avisosLoop() {
  try {
    const res = await fetch(`${config.hubUrl}/api/robo/avisos?token=${encodeURIComponent(config.ingestToken)}`)
    if (res.ok) {
      const data = await res.json()
      for (const a of data.avisos || []) {
        if (a.grupo) {
          await enviarNoGrupo(a.grupo, a.texto)
        } else {
          for (const dest of adminChats) {
            try {
              await client.sendMessage(dest, a.texto)
            } catch (e) {
              console.warn('⚠️ Falha ao avisar admin:', e.message)
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Erro ao buscar avisos:', e.message)
  }

  setTimeout(avisosLoop, 60000) // a cada 60s
}

// Histórico de conversa por número (em memória), p/ a IA lembrar do contexto
// (ex: pedir confirmação e você responder "confirmo").
const historicos = new Map()
const pendentes = new Map() // chave do chat -> ação pendente de confirmação
const falhasSeguidas = new Map() // chave do chat -> nº de falhas seguidas (anti-travamento)

/** Executa direto a ação pendente (já confirmada) — sem depender da IA lembrar. */
async function executarPendente(msg, pend) {
  try {
    const chat = await msg.getChat()
    chat.sendStateTyping()
  } catch {}
  try {
    const res = await fetch(`${config.hubUrl}/api/robo/executar-pendente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.ingestToken, pending: pend }),
    })
    const data = await res.json().catch(() => ({}))
    return msg.reply(data.resposta || '⚠️ Não consegui executar.')
  } catch (e) {
    return msg.reply('⚠️ Erro ao executar: ' + e.message)
  }
}

/** Limpa o contexto (histórico + pendência + contador de falhas) de um chat. */
function resetarConversa(chave) {
  historicos.delete(chave)
  pendentes.delete(chave)
  falhasSeguidas.delete(chave)
}

async function askAssistente(msg, textoOverride = null) {
  const pergunta = (textoOverride ?? msg.body ?? '').trim()
  const chave = soDigitos(msg.from)

  // Comando pra DESTRAVAR manualmente: zera a conversa desse chat.
  if (/^(reset|recome[çc]ar|limpar|esquece tudo|come[çc]ar de novo)\b/i.test(pergunta)) {
    resetarConversa(chave)
    return msg.reply('🧹 Limpei nossa conversa. Pode mandar de novo. 👍')
  }

  // Há ação pendente? Confirmação -> executa direto; negação -> cancela.
  const pend = pendentes.get(chave)
  if (pend && /^(sim|confirmo|confirmar|pode|isso|ok|aplica|manda|👍|claro)\b/i.test(pergunta)) {
    pendentes.delete(chave)
    return executarPendente(msg, pend)
  }
  if (pend && /^(n[ãa]o|cancela|cancelar|deixa)\b/i.test(pergunta)) {
    pendentes.delete(chave)
    return msg.reply('Ok, cancelei. Nada foi alterado. 👍')
  }

  const hist = historicos.get(chave) || []

  try {
    const chat = await msg.getChat()
    chat.sendStateTyping() // mostra "digitando..." enquanto a IA pensa
  } catch {}

  // Anti-travamento: em qualquer falha, NÃO suja o histórico. Conta as falhas
  // seguidas e, se repetir, reseta a conversa sozinho (antes ficava preso pra
  // sempre porque o histórico ruim era reenviado a cada mensagem).
  const aoFalhar = (texto) => {
    const n = (falhasSeguidas.get(chave) || 0) + 1
    if (n >= 2) {
      resetarConversa(chave)
      return msg.reply('⚠️ Tive um problema e reiniciei nossa conversa pra destravar. Pode mandar de novo? 🙏')
    }
    falhasSeguidas.set(chave, n)
    return msg.reply(texto)
  }

  try {
    const res = await fetch(`${config.hubUrl}/api/robo/assistente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.ingestToken, mensagem: pergunta, historico: hist }),
      signal: AbortSignal.timeout(45000), // não trava esperando o hub pra sempre
    })
    if (!res.ok) return aoFalhar(`⚠️ O hub respondeu com erro (${res.status}). Tenta de novo em instantes.`)

    const data = await res.json().catch(() => null)
    const resposta = data && data.resposta ? data.resposta : null
    if (!resposta) return aoFalhar('⚠️ Não consegui responder agora. Tenta de novo em instantes.')

    // Sucesso: zera o contador de falhas.
    falhasSeguidas.delete(chave)

    // Guarda (ou limpa) a ação pendente de confirmação.
    if (data.pending_action) pendentes.set(chave, data.pending_action)
    else pendentes.delete(chave)

    // Atualiza o histórico SÓ no sucesso (mantém curto).
    hist.push({ role: 'user', content: pergunta }, { role: 'assistant', content: resposta })
    while (hist.length > 10) hist.shift()
    historicos.set(chave, hist)

    return msg.reply(resposta)
  } catch (e) {
    const motivo = e.name === 'TimeoutError' ? 'o hub demorou demais' : e.message
    return aoFalhar(`⚠️ O hub não respondeu agora (${motivo}). Tenta de novo em instantes.`)
  }
}

// Opções do Chrome headless. Em Raspberry/mini-PC é melhor usar o Chromium do
// sistema (config.chromiumPath) e a flag --disable-dev-shm-usage (evita travar
// por falta de /dev/shm em máquinas com pouca RAM).
const puppeteerOpts = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
}
if (config.chromiumPath) {
  puppeteerOpts.executablePath = config.chromiumPath
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './sessao' }), // sessão persistente
  puppeteer: puppeteerOpts,
})

let pairCodeRequested = false
client.on('qr', async (qr) => {
  // Modo "conectar por código" (sem escanear QR): se existir o arquivo
  // pair-number.txt com o número, pede um código de pareamento de 8 dígitos.
  // Útil quando não dá pra apontar a câmera pra tela (acesso remoto).
  if (!pairCodeRequested && existsSync('pair-number.txt')) {
    pairCodeRequested = true
    try {
      const numero = readFileSync('pair-number.txt', 'utf8').replace(/\D/g, '')
      const code = await client.requestPairingCode(numero)
      console.log(`\n🔢 CÓDIGO DE PAREAMENTO (${numero}): ${code}`)
      console.log('   No WhatsApp do número: Aparelhos conectados → Conectar um aparelho → "Conectar com número de telefone" → digite o código.\n')
      try { writeFileSync('pair-code.txt', code) } catch {}
      return
    } catch (e) {
      console.error('⚠️ Falha ao pedir código de pareamento:', e.message, '— caindo pro QR.')
    }
  }
  console.log('\n📱 Escaneie o QR code abaixo com o WhatsApp do CHIP DEDICADO:\n')
  qrcode.generate(qr, { small: true })
  // Salva o QR puro em arquivo — permite gerar a imagem do QR pra parear
  // remotamente (sem depender do ASCII do log, que vem "sujo" pelo pm2).
  try { writeFileSync('qr-latest.txt', qr) } catch {}
})

client.on('authenticated', () => console.log('✅ Autenticado.'))
client.on('auth_failure', (m) => console.error('❌ Falha de autenticação:', m))
client.on('ready', () => {
  whatsappReady = true
  botId = client.info?.wid?._serialized || null // id do próprio bot (p/ detectar @menção)
  // Captura todos os ids possíveis do bot (número e @lid).
  const idsBot = [
    client.info?.wid?._serialized,
    client.info?.wid?.user,
    client.info?.me?._serialized,
    client.info?.lid?._serialized,
    client.info?.lid?.user,
  ]
  idsBot.forEach(lembrarBotId)
  console.log('ℹ️ ids do bot:', JSON.stringify(idsBot), '| botIds=', JSON.stringify([...botIds]))
  console.log('\n🤖 Robô no ar! Escutando os grupos... (Ctrl+C para parar)\n')
  notificarDemandasLoop() // começa a avisar o admin sobre novas demandas
  avisosLoop() // alertas/resumo/lembretes/resolvido-no-grupo
  reportarGrupos() // manda a lista de grupos pro painel
  setInterval(reportarGrupos, 5 * 60 * 1000) // atualiza a cada 5 min
})
client.on('disconnected', (r) => {
  whatsappReady = false
  console.warn('⚠️ Desconectado:', r)
})

// Evita reenviar a mesma mensagem (dedupe simples em memória).
const enviadas = new Set()

/** Mapeia o tipo de mensagem do WhatsApp para audio|video|image (ou null). */
function mapTipoMidia(type) {
  switch (type) {
    case 'ptt': // voice note
    case 'audio':
      return 'audio'
    case 'video':
      return 'video'
    case 'image':
      return 'image'
    default:
      return null
  }
}

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat()
    const c = cfg()

    // Resolve o número REAL do remetente. O msg.from às vezes vem como @lid
    // (um ID aleatório do WhatsApp), então pegamos o telefone pelo contato.
    let fromNum = soDigitos(msg.from)
    try {
      const contato = await msg.getContact()
      const n = contato?.number || contato?.id?.user
      if (n) fromNum = soDigitos(n)
    } catch {}

    // Em mensagem privada, o destino (msg.to) é o próprio bot — aprende o id/lid dele.
    if (!chat.isGroup && msg.to) lembrarBotId(msg.to)

    // Log de depuração: mostra toda mensagem recebida.
    console.log(
      `📩 ${chat.isGroup ? 'GRUPO "' + (chat.name || '?') + '"' : 'PRIVADO'} de ${fromNum}` +
        ` (from=${soDigitos(msg.from)}, to=${soDigitos(String(msg.to || ''))})` +
        ` | comando=${ehComando(fromNum, chat)}` +
        (chat.isGroup ? ` | mentions=${JSON.stringify(msg.mentionedIds || [])} | botIds=${JSON.stringify([...botIds])}` : '') +
        ` | "${(msg.body || '').slice(0, 50)}"`,
    )

    // COMANDO: mensagem privada de um número autorizado -> trata e responde
    // aqui mesmo (não segue para a lógica de demandas).
    if (ehComando(fromNum, chat)) {
      lembrarAdmin(msg.from) // guarda o chat p/ enviar avisos depois
      let comando = (msg.body || '').trim()
      // Comando por VOZ: se mandou áudio, transcreve antes.
      if (!comando && msg.hasMedia && mapTipoMidia(msg.type) === 'audio') {
        comando = await transcreverAudio(msg)
        if (comando) await msg.reply(`🎙️ _"${comando}"_`)
      }
      // DOCUMENTO/IMAGEM (PDF, Nota Fiscal, boleto...): lê e extrai os campos.
      if (msg.hasMedia && (msg.type === 'document' || mapTipoMidia(msg.type) === 'image')) {
        await lerDocumento(msg)
        return
      }
      await tratarComando(msg, comando)
      return
    }

    // GRUPO: se MARCAREM o bot (@menção do número ou "@bot"), ele responde no
    // grupo com a IA. Senão, segue como demanda normal.
    if (chat.isGroup) {
      const texto = (msg.body || '').trim()
      const mencionou = await botFoiMencionado(msg, texto)

      if (mencionou) {
        const ok = numeroAutorizado(fromNum)
        console.log(`   ↳ bot MARCADO no grupo | de=${fromNum} | autorizado=${ok}`)
        if (ok) {
          lembrarAdmin(msg.from)
          // tira menções (@número / @bot) do texto antes de perguntar à IA
          const pergunta = texto.replace(/@\d+/g, '').replace(/@?bot\b/i, '').trim()
          await askAssistente(msg, pergunta || texto)
        } else {
          await msg.reply(
            `🔒 Você não está autorizado a me comandar.\nSeu ID neste grupo: *${fromNum}*\nAdicione ele no painel (Robô & IA → números de controle).`,
          )
        }
        return // marcado nunca vira demanda
      }
    }

    // Só grupos (se configurado assim).
    if (c.apenasGrupos && !chat.isGroup) return

    const grupo = chat.name || ''

    // Modo whitelist: só processa grupos que estão mapeados no painel.
    if (c.somenteMapeados && chat.isGroup) {
      const mapeados = Object.keys(c.grupoParaSistema || {}).map((g) => g.toLowerCase())
      if (!mapeados.includes(grupo.toLowerCase())) return
    }

    const texto = (msg.body || '').trim()

    // Tipos de mídia que sabemos transcrever no hub (áudio por padrão).
    const tipoMidia = mapTipoMidia(msg.type)
    const querTranscrever =
      tipoMidia &&
      ((tipoMidia === 'audio' && c.transcreverAudio !== false) ||
        (tipoMidia === 'video' && c.transcreverVideo) ||
        (tipoMidia === 'image' && c.transcreverImagem))

    // Sem texto e sem mídia transcritível -> ignora.
    if (!texto && !querTranscrever) return

    // Filtro de grupos ignorados.
    if ((c.ignorarGrupos || []).some((p) => grupo.toLowerCase().includes(p.toLowerCase()))) return

    // Dedupe.
    if (enviadas.has(msg.id._serialized)) return
    enviadas.add(msg.id._serialized)
    if (enviadas.size > 5000) enviadas.clear()

    // Autor (nome do contato, se disponível).
    let autor = msg.author || msg.from || ''
    try {
      const contato = await msg.getContact()
      autor = contato.pushname || contato.name || contato.number || autor
    } catch {}

    const systemSlug = c.grupoParaSistema?.[grupo] || null

    const payload = {
      message: texto || '',
      group: grupo,
      author: autor,
      system_slug: systemSlug,
      message_at: new Date(msg.timestamp * 1000).toISOString(),
    }

    // Baixa a mídia (base64) se for transcritível e couber no limite.
    if (querTranscrever) {
      try {
        const media = await msg.downloadMedia()
        if (media?.data) {
          const limiteMb = c.maxMidiaMb || 16
          const tamanhoMb = (media.data.length * 0.75) / (1024 * 1024) // base64 -> bytes
          if (tamanhoMb <= limiteMb) {
            payload.media_type = tipoMidia
            payload.media_mime = media.mimetype || ''
            payload.media_base64 = media.data
          } else {
            console.warn(`⚠️ Mídia ignorada (${tamanhoMb.toFixed(1)}MB > ${limiteMb}MB) — grupo: ${grupo}`)
            if (!texto) return // sem texto e mídia grande demais: descarta
          }
        }
      } catch (e) {
        console.warn('⚠️ Falha ao baixar mídia:', e.message)
        if (!texto) return
      }
    }

    await enviarAoHub(payload)
  } catch (e) {
    console.error('Erro ao processar mensagem:', e.message)
  }
})

async function enviarAoHub(payload) {
  try {
    const res = await fetch(`${config.hubUrl}/api/demands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.ingestToken, ...payload }),
    })
    const data = await res.json().catch(() => ({}))
    if (data.stored) {
      console.log(`📥 Demanda registrada (#${data.id}) — grupo: ${payload.group}`)
    }
    // Mensagens 'not_relevant' são silenciosamente ignoradas (conversa normal).
  } catch (e) {
    console.error('Falha ao enviar ao hub:', e.message)
  }
}

// Busca a config do hub antes de iniciar e renova a cada 1 min.
await carregarConfigRemota()
setInterval(carregarConfigRemota, 60_000)

// Baseline do auto-update/reinício = estado atual (boot nunca dispara). Depois,
// mudança de nonce (botões "Atualizar/Reiniciar robô" no painel) age sozinho.
updateBaseline = remote?.update_nonce ?? null
restartBaseline = remote?.restart_nonce ?? null
autoUpdateLoop()

// Começa a reportar o estado ao hub (mesmo antes do WhatsApp conectar).
heartbeatLoop()

client.initialize()
