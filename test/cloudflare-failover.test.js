import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { criarControladorFailover } from '../cloudflare-failover.js'

function response(result, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => ({ success: ok, result, errors: ok ? [] : [{ message: 'erro simulado' }] }),
  }
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'nexok-failover-'))
  let clock = 100_000
  let patchCount = 0
  let notificationsAllowed = true
  let record = {
    id: 'record-1',
    type: 'A',
    name: 'pires-dashboard.a3pprog.com.br',
    content: '216.172.172.112',
    proxied: true,
  }
  const notifications = []
  const events = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/client/v4/zones') return response([{ id: 'zone-1' }])
    if (parsed.pathname.endsWith('/dns_records') && (!init.method || init.method === 'GET')) {
      return response([record])
    }
    if (parsed.pathname.endsWith(`/dns_records/${record.id}`) && init.method === 'PATCH') {
      patchCount++
      record = { ...record, ...JSON.parse(init.body) }
      return response(record)
    }
    return response(null, { ok: false, status: 404 })
  }
  const controller = criarControladorFailover({
    options: {
      apiToken: 'token-de-teste',
      zoneName: 'a3pprog.com.br',
      failuresRequired: 3,
      recoveriesRequired: 3,
      cooldownMs: 15 * 60_000,
      pendingTtlMs: 10 * 60_000,
      sites: {
        'pires-dashboard': {
          name: 'Pires Dashboard',
          hostname: 'pires-dashboard.a3pprog.com.br',
          primaryIp: '216.172.172.112',
          fallbackTarget: 'pires-textil.pages.dev',
        },
      },
    },
    fetchImpl,
    notify: async (text) => notifications.push(text),
    canNotify: () => notificationsAllowed,
    audit: (event) => events.push(event),
    stateFile: join(temporary, 'state.json'),
    now: () => clock,
  })
  return {
    controller,
    notifications,
    events,
    patchCount: () => patchCount,
    record: () => record,
    advance: (ms) => { clock += ms },
    allowNotifications: (allowed) => { notificationsAllowed = allowed },
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  }
}

test('três falhas apenas pedem autorização; confirmação exata aplica e retorno também exige autorização', async () => {
  const f = fixture()
  try {
    const down = { status: 'down', detail: 'timeout carregando máquinas' }
    const primaryOk = async () => ({ status: 'ok', detail: 'HostGator respondeu' })

    await f.controller.observe('pires-dashboard', down, primaryOk)
    await f.controller.observe('pires-dashboard', down, primaryOk)
    assert.equal(f.notifications.length, 0)
    assert.equal(f.patchCount(), 0)

    await f.controller.observe('pires-dashboard', down, primaryOk)
    assert.equal(f.notifications.length, 1)
    assert.equal(f.patchCount(), 0, 'monitoramento nunca pode alterar DNS')

    const generic = await f.controller.handleCommand('ok')
    assert.equal(generic.handled, false)
    assert.equal(f.patchCount(), 0)

    const command = f.notifications[0].match(/CONFIRMAR FAILOVER PIRES-DASHBOARD [A-F0-9]{6}/)?.[0]
    assert.ok(command)
    const wrong = await f.controller.handleCommand(command.replace(/[A-F0-9]$/, 'Z'))
    assert.equal(wrong.handled, false)
    assert.equal(f.patchCount(), 0)

    const confirmed = await f.controller.handleCommand(command)
    assert.equal(confirmed.handled, true)
    assert.match(confirmed.text, /Failover confirmado/)
    assert.equal(f.patchCount(), 1)
    assert.equal(f.record().type, 'CNAME')
    assert.equal(f.record().content, 'pires-textil.pages.dev')

    f.advance(16 * 60_000)
    await f.controller.observe('pires-dashboard', { status: 'ok' }, primaryOk)
    await f.controller.observe('pires-dashboard', { status: 'ok' }, primaryOk)
    assert.equal(f.notifications.length, 1)
    await f.controller.observe('pires-dashboard', { status: 'ok' }, primaryOk)
    assert.equal(f.notifications.length, 2)
    assert.equal(f.patchCount(), 1, 'recuperação também não pode alterar DNS automaticamente')

    const returnCommand = f.notifications[1].match(/CONFIRMAR RETORNO PIRES-DASHBOARD [A-F0-9]{6}/)?.[0]
    assert.ok(returnCommand)
    const returned = await f.controller.handleCommand(returnCommand)
    assert.equal(returned.handled, true)
    assert.match(returned.text, /Retorno confirmado/)
    assert.equal(f.patchCount(), 2)
    assert.equal(f.record().type, 'A')
    assert.equal(f.record().content, '216.172.172.112')
  } finally {
    f.cleanup()
  }
})

test('sem token o controlador fica somente desativado', async () => {
  let notified = false
  const controller = criarControladorFailover({
    options: {
      apiToken: '',
      sites: {
        site: {
          name: 'Site',
          hostname: 'site.a3pprog.com.br',
          primaryIp: '216.172.172.112',
          fallbackTarget: 'site.pages.dev',
        },
      },
    },
    notify: async () => { notified = true },
  })

  await controller.observe('site', { status: 'down' }, async () => ({ status: 'ok' }))
  assert.equal(notified, false)
  const status = await controller.handleCommand('status failover')
  assert.match(status.text, /desativado/)
})

test('modo silencioso não cria nem repete pedido de retorno do failover', async () => {
  const f = fixture()
  try {
    const down = { status: 'down', detail: 'timeout carregando máquinas' }
    const primaryOk = async () => ({ status: 'ok', detail: 'HostGator respondeu' })

    await f.controller.observe('pires-dashboard', down, primaryOk)
    await f.controller.observe('pires-dashboard', down, primaryOk)
    await f.controller.observe('pires-dashboard', down, primaryOk)
    const failoverCommand = f.notifications[0].match(/CONFIRMAR FAILOVER PIRES-DASHBOARD [A-F0-9]{6}/)?.[0]
    assert.ok(failoverCommand)
    await f.controller.handleCommand(failoverCommand)

    f.advance(16 * 60_000)
    f.allowNotifications(false)
    for (let i = 0; i < 12; i++) {
      await f.controller.observe('pires-dashboard', { status: 'ok' }, primaryOk)
      f.advance(60_000)
    }

    assert.equal(f.notifications.length, 1, 'nenhum retorno deve ser enviado durante o silêncio')
    assert.equal(f.controller.snapshot().sites['pires-dashboard'].pending, null)

    f.allowNotifications(true)
    await f.controller.observe('pires-dashboard', { status: 'ok' }, primaryOk)
    assert.equal(f.notifications.length, 2, 'o pedido pode ser criado quando o modo normal voltar')
    assert.match(f.notifications[1], /CONFIRMAR RETORNO PIRES-DASHBOARD/)
  } finally {
    f.cleanup()
  }
})
