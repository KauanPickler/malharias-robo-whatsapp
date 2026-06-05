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

// Estado do robô (para o heartbeat / painel).
const bootTime = new Date().toISOString()
const VERSION = '1.0.0'
let whatsappReady = false

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

/** O número (já resolvido) é de alguém autorizado a comandar o bot? */
function ehComando(fromNum, chat) {
  if (chat.isGroup) return false
  const autorizados = (cfg().controleNumeros || []).map(soDigitos).filter(Boolean)
  if (!autorizados.length) return false
  // Compara pelos últimos 8 dígitos (ignora 55/DDD e o 9º dígito que o WhatsApp
  // às vezes acrescenta/remove nos números do Brasil).
  const tail = (s) => String(s).slice(-8)
  return autorizados.some((n) => tail(n).length === 8 && tail(n) === tail(fromNum))
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

/** Interpreta e executa um comando recebido por mensagem privada. */
async function tratarComando(msg) {
  const texto = (msg.body || '').trim()
  const lower = texto.toLowerCase()

  if (lower === 'ajuda' || lower === '/ajuda' || lower === 'help' || lower === 'menu') {
    return msg.reply(
      '🤖 *Posso te ajudar com:*\n' +
        '• *resumo do grupo NOME* — resumo das mensagens do grupo\n' +
        '• *grupos* — lista os grupos disponíveis\n\n' +
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
  return askAssistente(msg)
}

/**
 * Avisa o(s) admin(s) no WhatsApp quando uma nova demanda é registrada.
 * Consulta o hub a cada 60s e envia o resumo (classificado pela IA).
 */
async function notificarDemandasLoop() {
  try {
    const c = cfg()
    const admins = (c.controleNumeros || []).map(soDigitos).filter(Boolean)

    if (c.notificarDemandas !== false && admins.length) {
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

          for (const num of admins) {
            try {
              await client.sendMessage(`${num}@c.us`, texto)
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

// Histórico de conversa por número (em memória), p/ a IA lembrar do contexto
// (ex: pedir confirmação e você responder "confirmo").
const historicos = new Map()

async function askAssistente(msg) {
  const chave = soDigitos(msg.from)
  const hist = historicos.get(chave) || []

  try {
    const chat = await msg.getChat()
    chat.sendStateTyping() // mostra "digitando..." enquanto a IA pensa
  } catch {}

  try {
    const res = await fetch(`${config.hubUrl}/api/robo/assistente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.ingestToken, mensagem: msg.body, historico: hist }),
    })
    const data = await res.json().catch(() => ({}))
    const resposta = data.resposta || '⚠️ Não consegui responder agora.'

    // Atualiza o histórico (mantém curto).
    hist.push({ role: 'user', content: msg.body }, { role: 'assistant', content: resposta })
    while (hist.length > 10) hist.shift()
    historicos.set(chave, hist)

    return msg.reply(resposta)
  } catch (e) {
    return msg.reply('⚠️ Erro ao falar com o hub: ' + e.message)
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

client.on('qr', (qr) => {
  console.log('\n📱 Escaneie o QR code abaixo com o WhatsApp do CHIP DEDICADO:\n')
  qrcode.generate(qr, { small: true })
})

client.on('authenticated', () => console.log('✅ Autenticado.'))
client.on('auth_failure', (m) => console.error('❌ Falha de autenticação:', m))
client.on('ready', () => {
  whatsappReady = true
  console.log('\n🤖 Robô no ar! Escutando os grupos... (Ctrl+C para parar)\n')
  notificarDemandasLoop() // começa a avisar o admin sobre novas demandas
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

    // Log de depuração: mostra toda mensagem recebida.
    console.log(
      `📩 ${chat.isGroup ? 'GRUPO "' + (chat.name || '?') + '"' : 'PRIVADO'} de ${fromNum}` +
        ` (from=${soDigitos(msg.from)}) | comando=${ehComando(fromNum, chat)} | "${(msg.body || '').slice(0, 60)}"`,
    )

    // COMANDO: mensagem privada de um número autorizado -> trata e responde
    // aqui mesmo (não segue para a lógica de demandas).
    if (ehComando(fromNum, chat)) {
      await tratarComando(msg)
      return
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

// Começa a reportar o estado ao hub (mesmo antes do WhatsApp conectar).
heartbeatLoop()

client.initialize()
