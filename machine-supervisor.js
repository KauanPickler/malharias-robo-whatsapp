const DEFAULT_TIMEZONE = 'America/Sao_Paulo'

/** Extrai JSON mesmo quando o proxy PHP antepõe warnings/HTML à resposta. */
export function parseJsonTolerante(raw) {
  const text = String(raw || '').trim()
  try { return JSON.parse(text) } catch {}
  const starts = [...text.matchAll(/[\[{]/g)].map((match) => match.index)
  for (const start of starts) {
    try { return JSON.parse(text.slice(start)) } catch {}
  }
  throw new Error('resposta não contém JSON válido')
}

function numero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function timestamp(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}-03:00`) || 0
}

function mediana(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function partesAgora(nowMs, timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function turnoAtual(nowMs, timezone = DEFAULT_TIMEZONE) {
  const parts = partesAgora(nowMs, timezone)
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  if (minutes >= 5 * 60 && minutes < 13 * 60 + 30) return { key: 'A', field: 'turno_a' }
  if (minutes >= 13 * 60 + 30 && minutes < 22 * 60) return { key: 'B', field: 'turno_b' }
  return { key: 'C', field: 'turno_c' }
}

function causasDosRegistros(records, failureNames, nowMs) {
  const recent = records.filter((record) => nowMs - timestamp(record.data) <= 12 * 60 * 60 * 1000)
  const failures = new Map()
  let blocks = 0
  let restarts = 0
  let stops = 0

  for (const record of recent) {
    const failure = numero(record.n_falha)
    if (failure > 0 && failure !== 999) failures.set(failure, (failures.get(failure) || 0) + 1)
    if (numero(record.block) === 1) blocks++
    if (numero(record.status) === 5) restarts++
    if (numero(record.status) === 0) stops++
  }

  const causes = [...failures.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => `${failureNames[code] || `falha ${code}`} (${count}x)`)
  if (blocks) causes.push(`${blocks} bloqueio(s) registrado(s)`)
  if (restarts) causes.push(`${restarts} reinício(s) do coletor`)
  if (!causes.length && stops) causes.push(`${stops} evento(s) de parada, sem causa informada`)
  return causes
}

function machineSnapshot(machine, failureNames, nowMs, offlineMinutes, turno) {
  const records = [...(machine.records || [])]
    .filter((record) => timestamp(record.data) > 0)
    .sort((a, b) => timestamp(a.data) - timestamp(b.data))
  const latest = records.at(-1) || null
  const latestAt = latest ? timestamp(latest.data) : 0
  const ageMinutes = latestAt ? Math.max(0, Math.floor((nowMs - latestAt) / 60000)) : Infinity
  const value = latest ? numero(latest[turno.field]) : 0
  return {
    id: String(machine.id),
    records,
    latest,
    latestAt,
    ageMinutes,
    online: Boolean(latestAt && ageMinutes <= offlineMinutes),
    value,
    status: latest ? numero(latest.status) : null,
    rpm: latest ? numero(latest.rpm) : 0,
    causes: causasDosRegistros(records, failureNames, nowMs),
  }
}

/**
 * Detecta indisponibilidade e produção fora do padrão usando a mediana das
 * máquinas da mesma malharia. Limites conservadores evitam comparar diferenças
 * pequenas ou grupos com menos de três máquinas ativas.
 */
export function analisarMaquinas({
  machines = [],
  failureNames = {},
  nowMs = Date.now(),
  timezone = DEFAULT_TIMEZONE,
  offlineMinutes = 20,
  lowRatio = 0.50,
  highRatio = 3,
  minimumPeerMedian = 500,
  minimumGap = 500,
} = {}) {
  const turno = turnoAtual(nowMs, timezone)
  const snapshots = machines.map((machine) => machineSnapshot(machine, failureNames, nowMs, offlineMinutes, turno))
  const peerValues = snapshots.filter((machine) => machine.online && machine.value > 0).map((machine) => machine.value)
  const peerMedian = mediana(peerValues)
  const canCompare = peerValues.length >= 3 && peerMedian >= minimumPeerMedian
  const issues = []

  for (const machine of snapshots) {
    // Cadastro sem qualquer leitura no período pode ser máquina desativada ou
    // de teste. Ela fica como "sem histórico", mas não gera falso alerta.
    if (!machine.latestAt) continue
    if (!machine.online) {
      issues.push({
        machine: machine.id,
        type: 'offline',
        severity: 'critical',
        title: `Máquina ${machine.id} offline`,
        detail: machine.latestAt
          ? `sem enviar dados há ${machine.ageMinutes} min`
          : 'nenhum dado encontrado no período consultado',
        causes: machine.causes,
      })
      continue
    }

    if (canCompare && machine.value < peerMedian * lowRatio && peerMedian - machine.value >= minimumGap) {
      issues.push({
        machine: machine.id,
        type: 'production-low',
        severity: 'warning',
        title: `Produção muito baixa na máquina ${machine.id}`,
        detail: `turno ${turno.key}: ${Math.round(machine.value).toLocaleString('pt-BR')} contra mediana de ${Math.round(peerMedian).toLocaleString('pt-BR')} (${Math.round(machine.value / peerMedian * 100)}% do padrão)`,
        causes: machine.causes.length ? machine.causes : [machine.rpm <= 0 ? 'RPM atual zerado' : 'sem falha identificada nos eventos recentes'],
      })
    } else if (canCompare && machine.value > peerMedian * highRatio && machine.value - peerMedian >= minimumGap) {
      issues.push({
        machine: machine.id,
        type: 'production-high',
        severity: 'warning',
        title: `Produção fora da curva na máquina ${machine.id}`,
        detail: `turno ${turno.key}: ${Math.round(machine.value).toLocaleString('pt-BR')} contra mediana de ${Math.round(peerMedian).toLocaleString('pt-BR')} (${Math.round(machine.value / peerMedian * 100)}% do padrão)`,
        causes: ['possível contador incorreto, reinício ou configuração divergente'],
      })
    }
  }

  return { turno: turno.key, peerMedian, activeMachines: peerValues.length, snapshots, issues }
}

export function formatarRelatorioMaquinas(siteName, analysis, issues = analysis.issues) {
  const critical = issues.filter((issue) => issue.severity === 'critical').length
  const lines = [
    `🧶 *Relatório de máquinas — ${siteName}*`,
    `Turno ${analysis.turno} · ${analysis.activeMachines} máquina(s) com dados recentes`,
    analysis.peerMedian > 0 ? `Mediana de produção: ${Math.round(analysis.peerMedian).toLocaleString('pt-BR')} batidas` : 'Mediana de produção: indisponível',
    `Ocorrências: ${issues.length}${critical ? ` · ${critical} crítica(s)` : ''}`,
  ]

  for (const issue of issues) {
    lines.push('', `${issue.severity === 'critical' ? '🔴' : '🟠'} *${issue.title}*`, issue.detail)
    if (issue.causes?.length) lines.push(`Indícios: ${issue.causes.join(' · ')}`)
  }
  lines.push('', '_Análise automática baseada nas leituras e eventos das últimas 24 horas._')
  return lines.join('\n')
}
