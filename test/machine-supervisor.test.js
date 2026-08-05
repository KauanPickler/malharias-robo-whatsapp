import test from 'node:test'
import assert from 'node:assert/strict'
import { analisarMaquinas, formatarRelatorioMaquinas, parseJsonTolerante } from '../machine-supervisor.js'

const NOW = Date.parse('2026-08-05T12:00:00-03:00')

function record(turnoA, data = '2026-08-05 11:59:00', extra = {}) {
  return { turno_a: turnoA, turno_b: 0, turno_c: 0, status: 1, rpm: 25, n_falha: 0, block: 0, data, ...extra }
}

test('detecta máquina offline e produção baixa, explicando pelas falhas recentes', () => {
  const analysis = analisarMaquinas({
    nowMs: NOW,
    offlineMinutes: 20,
    failureNames: { 7: 'Problema mecânico' },
    machines: [
      { id: '1', records: [record(100_000)] },
      { id: '2', records: [record(110_000)] },
      { id: '3', records: [record(90_000)] },
      { id: '4', records: [
        record(9_000, '2026-08-05 11:30:00', { status: 0, n_falha: 7, block: 1, rpm: 0 }),
        record(10_000),
      ] },
      { id: '5', records: [record(70_000, '2026-08-05 11:20:00')] },
    ],
  })

  const low = analysis.issues.find((issue) => issue.machine === '4' && issue.type === 'production-low')
  const offline = analysis.issues.find((issue) => issue.machine === '5' && issue.type === 'offline')
  assert.ok(low)
  assert.match(low.detail, /10\.000/)
  assert.match(low.causes.join(' '), /Problema mecânico/)
  assert.match(low.causes.join(' '), /bloqueio/)
  assert.ok(offline)
  assert.match(offline.detail, /40 min/)

  const report = formatarRelatorioMaquinas('Malharia Teste', analysis)
  assert.match(report, /Relatório de máquinas/)
  assert.match(report, /Produção muito baixa/)
  assert.match(report, /Máquina 5 offline/)
})

test('não acusa diferenças pequenas nem compara grupo insuficiente', () => {
  const analysis = analisarMaquinas({
    nowMs: NOW,
    machines: [
      { id: '1', records: [record(100_000)] },
      { id: '2', records: [record(105_000)] },
      { id: '200', records: [] },
    ],
  })
  assert.deepEqual(analysis.issues, [])
})

test('aceita JSON precedido por warning HTML do proxy PHP', () => {
  const parsed = parseJsonTolerante('<br><b>Warning</b>: aviso do PHP<br>\n[{"maquina":"03"}]')
  assert.deepEqual(parsed, [{ maquina: '03' }])
})
