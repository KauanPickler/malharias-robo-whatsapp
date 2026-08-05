import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomBytes, randomUUID } from 'crypto'

const API_BASE = 'https://api.cloudflare.com/client/v4'

function normalizarHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '')
}

function estadoInicial() {
  return { version: 1, sites: {} }
}

function codigoConfirmacao() {
  return randomBytes(3).toString('hex').toUpperCase()
}

function erroCloudflare(data, fallback) {
  const messages = [...(data?.errors || []), ...(data?.messages || [])]
    .map((item) => item?.message)
    .filter(Boolean)
  return messages.join(' · ') || fallback
}

export function criarControladorFailover({
  options = {},
  fetchImpl = fetch,
  notify = async () => {},
  canNotify = () => true,
  audit = () => {},
  stateFile = './failover-state.json',
  now = () => Date.now(),
} = {}) {
  const sites = options.sites || {}
  const token = String(options.apiToken || '').trim()
  const zoneName = normalizarHost(options.zoneName || 'a3pprog.com.br')
  const failuresRequired = Number(options.failuresRequired || 3)
  const recoveriesRequired = Number(options.recoveriesRequired || 3)
  const cooldownMs = Number(options.cooldownMs || 15 * 60 * 1000)
  const pendingTtlMs = Number(options.pendingTtlMs || 10 * 60 * 1000)
  let zoneId = String(options.zoneId || '').trim() || null
  let state = estadoInicial()
  let warnedDisabled = false

  try {
    if (existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.sites) state = parsed
    }
  } catch {
    state = estadoInicial()
  }

  function enabled() {
    return options.enabled !== false && Boolean(token && zoneName && Object.keys(sites).length)
  }

  function persist() {
    const temporary = `${stateFile}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2))
    renameSync(temporary, stateFile)
  }

  function siteState(key) {
    if (!state.sites[key]) {
      state.sites[key] = {
        mode: 'unknown',
        failures: 0,
        recoveries: 0,
        pending: null,
        lastSwitchAt: 0,
        lastObservedAt: 0,
      }
    }
    return state.sites[key]
  }

  async function api(path, init = {}) {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: init.signal || AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.success === false) {
      throw new Error(erroCloudflare(data, `Cloudflare HTTP ${res.status}`))
    }
    return data?.result
  }

  async function obterZoneId() {
    if (zoneId) return zoneId
    const zones = await api(`/zones?name=${encodeURIComponent(zoneName)}&status=active`)
    if (!Array.isArray(zones) || zones.length !== 1) {
      throw new Error(`Zona ${zoneName} ainda não está ativa ou não foi encontrada.`)
    }
    zoneId = zones[0].id
    return zoneId
  }

  async function obterRegistro(site) {
    const zid = await obterZoneId()
    const records = await api(
      `/zones/${encodeURIComponent(zid)}/dns_records?name=${encodeURIComponent(site.hostname)}`,
    )
    const record = Array.isArray(records) ? records.find((item) => normalizarHost(item.name) === site.hostname) : null
    if (!record) throw new Error(`Registro DNS ${site.hostname} não encontrado.`)
    return record
  }

  function modoDoRegistro(site, record) {
    const type = String(record?.type || '').toUpperCase()
    const content = normalizarHost(record?.content)
    if (type === 'A' && content === String(site.primaryIp || '').trim()) return 'primary'
    if (type === 'CNAME' && content === normalizarHost(site.fallbackTarget)) return 'fallback'
    return 'unknown'
  }

  function limparPendenteExpirado(st) {
    if (st.pending && Number(st.pending.expiresAt || 0) <= now()) {
      st.pending = null
      persist()
    }
  }

  async function sincronizar(siteKey) {
    const site = sites[siteKey]
    if (!site) throw new Error(`Site de failover desconhecido: ${siteKey}`)
    const record = await obterRegistro(site)
    const st = siteState(siteKey)
    st.mode = modoDoRegistro(site, record)
    st.recordId = record.id
    st.recordType = record.type
    st.recordContent = record.content
    st.lastSyncAt = now()
    limparPendenteExpirado(st)
    persist()
    return { site, record, state: st }
  }

  function comandoPendente(pending) {
    return `CONFIRMAR ${pending.action === 'failover' ? 'FAILOVER' : 'RETORNO'} ${pending.siteKey.toUpperCase()} ${pending.code}`
  }

  async function criarPedido(siteKey, action, detail) {
    const site = sites[siteKey]
    const st = siteState(siteKey)
    limparPendenteExpirado(st)
    if (st.pending) return
    if (st.lastSwitchAt && now() - Number(st.lastSwitchAt) < cooldownMs) return
    // O modo silencioso/noturno precisa impedir a criação do pedido, e não
    // apenas ocultar seu envio. Caso contrário, o pedido expira e é recriado
    // continuamente, gerando uma nova notificação a cada ciclo.
    if (!canNotify()) return

    const pending = {
      id: randomUUID(),
      siteKey,
      action,
      code: codigoConfirmacao(),
      detail: String(detail || ''),
      createdAt: now(),
      expiresAt: now() + pendingTtlMs,
    }
    st.pending = pending
    persist()

    const destino = action === 'failover'
      ? `Cloudflare Pages (${site.fallbackTarget})`
      : `HostGator (${site.primaryIp})`
    const titulo = action === 'failover' ? '🚨 *Failover disponível*' : '✅ *HostGator recuperou*'
    const texto =
      `${titulo}\n` +
      `*${site.name}*\n` +
      `${site.hostname}\n` +
      `Motivo: ${pending.detail}\n` +
      `Destino proposto: ${destino}\n\n` +
      `Nada será alterado sem sua autorização.\n` +
      `Para confirmar, responda exatamente:\n\n` +
      `*${comandoPendente(pending)}*\n\n` +
      `Expira em ${Math.round(pendingTtlMs / 60000)} minutos.`
    await notify(texto)
    audit({
      type: 'action',
      category: 'failover',
      status: 'pending',
      level: action === 'failover' ? 'warning' : 'info',
      title: `${action === 'failover' ? 'Failover' : 'Retorno'} aguardando autorização: ${site.name}`,
      message: texto,
      context: { site: siteKey, request_id: pending.id, action },
    })
  }

  async function observe(siteKey, publicResult, checkPrimary) {
    if (!enabled() || !sites[siteKey]) {
      if (!enabled() && !warnedDisabled) {
        warnedDisabled = true
        audit({
          level: 'warning',
          category: 'failover',
          title: 'Failover Cloudflare desativado',
          message: 'Configure CLOUDFLARE_API_TOKEN para habilitar as solicitações assistidas.',
        })
      }
      return
    }

    const st = siteState(siteKey)
    limparPendenteExpirado(st)
    if (!st.lastSyncAt || now() - st.lastSyncAt >= 5 * 60 * 1000 || st.mode === 'unknown') {
      try {
        await sincronizar(siteKey)
      } catch (error) {
        audit({
          level: 'error',
          category: 'failover',
          title: `Falha ao consultar DNS: ${sites[siteKey].name}`,
          message: error.message,
        })
        return
      }
    }

    st.lastObservedAt = now()
    if (st.mode === 'primary') {
      st.recoveries = 0
      if (publicResult?.status === 'down') st.failures += 1
      else st.failures = 0
      persist()
      if (st.failures >= failuresRequired) {
        await criarPedido(siteKey, 'failover', `${st.failures} falhas seguidas — ${publicResult?.detail || 'sem resposta'}`)
      }
      return
    }

    if (st.mode === 'fallback') {
      st.failures = 0
      const primaryResult = await checkPrimary(sites[siteKey])
      if (primaryResult?.status === 'ok') st.recoveries += 1
      else st.recoveries = 0
      persist()
      if (st.recoveries >= recoveriesRequired) {
        await criarPedido(
          siteKey,
          'return',
          `${st.recoveries} verificações positivas — ${primaryResult?.detail || 'origem respondeu'}`,
        )
      }
    }
  }

  async function aplicar(pending) {
    const { site, record, state: st } = await sincronizar(pending.siteKey)
    const expectedMode = pending.action === 'failover' ? 'primary' : 'fallback'
    if (st.mode !== expectedMode) {
      throw new Error(`O DNS mudou desde o pedido (estado atual: ${st.mode}). Nenhuma alteração foi feita.`)
    }

    const target = pending.action === 'failover'
      ? { type: 'CNAME', content: normalizarHost(site.fallbackTarget), mode: 'fallback' }
      : { type: 'A', content: site.primaryIp, mode: 'primary' }
    const zid = await obterZoneId()
    const updated = await api(
      `/zones/${encodeURIComponent(zid)}/dns_records/${encodeURIComponent(record.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          type: target.type,
          name: site.hostname,
          content: target.content,
          ttl: 1,
          proxied: true,
          comment: `NexoK failover assistido ${new Date(now()).toISOString()}`,
        }),
      },
    )
    if (modoDoRegistro(site, updated) !== target.mode) {
      throw new Error('A Cloudflare respondeu, mas o registro não ficou no destino esperado.')
    }

    st.mode = target.mode
    st.pending = null
    st.failures = 0
    st.recoveries = 0
    st.lastSwitchAt = now()
    st.lastSyncAt = now()
    st.recordId = updated.id
    st.recordType = updated.type
    st.recordContent = updated.content
    persist()
    audit({
      type: 'action',
      category: 'failover',
      status: 'completed',
      title: `${pending.action === 'failover' ? 'Failover aplicado' : 'Retorno aplicado'}: ${site.name}`,
      context: { site: pending.siteKey, request_id: pending.id, mode: target.mode },
    })
    return pending.action === 'failover'
      ? `✅ Failover confirmado. *${site.name}* agora aponta para ${site.fallbackTarget}.`
      : `✅ Retorno confirmado. *${site.name}* agora aponta novamente para a HostGator (${site.primaryIp}).`
  }

  async function handleCommand(text) {
    const value = String(text || '').trim()
    if (/^(status\s+failover|failover\s+status|\/failover)$/i.test(value)) {
      if (!enabled()) {
        return {
          handled: true,
          text: '⚠️ Failover assistido desativado: configure CLOUDFLARE_API_TOKEN no Raspberry.',
        }
      }
      const lines = []
      for (const [key, site] of Object.entries(sites)) {
        const st = siteState(key)
        limparPendenteExpirado(st)
        const pending = st.pending ? ` · aguardando ${st.pending.action === 'failover' ? 'failover' : 'retorno'}` : ''
        lines.push(`• *${site.name}*: ${st.mode}${pending}`)
      }
      return { handled: true, text: `☁️ *Failover assistido*\n${lines.join('\n')}` }
    }

    const cancel = /^CANCELAR\s+(?:FAILOVER|RETORNO)\s+([A-Z0-9-]+)$/i.exec(value)
    if (cancel) {
      const key = cancel[1].toLowerCase()
      const st = state.sites[key]
      if (!st?.pending) return { handled: true, text: `Não existe solicitação pendente para ${key}.` }
      st.pending = null
      st.failures = 0
      st.recoveries = 0
      persist()
      return { handled: true, text: `🛑 Solicitação de ${key} cancelada. Nenhum DNS foi alterado.` }
    }

    const match = /^CONFIRMAR\s+(FAILOVER|RETORNO)\s+([A-Z0-9-]+)\s+([A-F0-9]{6})$/i.exec(value)
    if (!match) return { handled: false }

    const action = match[1].toUpperCase() === 'FAILOVER' ? 'failover' : 'return'
    const key = match[2].toLowerCase()
    const code = match[3].toUpperCase()
    const st = state.sites[key]
    if (!st?.pending) return { handled: true, text: `Não existe solicitação pendente para ${key}.` }
    if (st.pending.expiresAt <= now()) {
      st.pending = null
      persist()
      return { handled: true, text: '⌛ Essa autorização expirou. Nenhum DNS foi alterado.' }
    }
    if (st.pending.action !== action || st.pending.code !== code) {
      return { handled: true, text: '❌ Código ou tipo de autorização inválido. Nenhum DNS foi alterado.' }
    }

    const pending = { ...st.pending }
    try {
      return { handled: true, text: await aplicar(pending) }
    } catch (error) {
      audit({
        type: 'action',
        level: 'error',
        category: 'failover',
        status: 'failed',
        title: `Falha ao alterar DNS: ${sites[key]?.name || key}`,
        message: error.message,
        context: { site: key, request_id: pending.id, action },
      })
      return { handled: true, text: `❌ Não alterei o DNS: ${error.message}` }
    }
  }

  return {
    enabled,
    observe,
    handleCommand,
    snapshot: () => JSON.parse(JSON.stringify(state)),
    sync: sincronizar,
  }
}
