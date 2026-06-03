# Robô do WhatsApp — Malharias Hub

Escuta os grupos do WhatsApp (somente leitura) e envia as mensagens ao
Malharias Hub, que classifica com IA e registra como **demanda**.

## ⚠️ Aviso importante

Usa a biblioteca `whatsapp-web.js` (não-oficial). Isso **viola os Termos de
Serviço do WhatsApp** e o número **pode ser banido**. Por isso:

- **Use SEMPRE um chip dedicado** (nunca seu número pessoal/da empresa).
- O robô **só lê, nunca envia** mensagens nos grupos (reduz o risco).
- Rode num PC que pode ficar ligado (o robô precisa estar de pé pra escutar).

## Pré-requisitos (no PC velho)

1. **Node.js 18+** — https://nodejs.org (versão LTS)
2. **Google Chrome** instalado (o robô usa ele por baixo)

## Instalação

```bash
# 1. Entre na pasta do robô
cd malharias-robo-whatsapp

# 2. Instale as dependências
npm install

# 3. Configure
cp config.example.js config.js
#    edite config.js e cole o TOKEN gerado no hub
#    (Hub > Configurações > Robô do WhatsApp > Gerar token)

# 4. Rode
npm start
```

Na **primeira vez**, vai aparecer um **QR code** no terminal. Abra o WhatsApp do
**chip dedicado** → Aparelhos conectados → Conectar um aparelho → escaneie.
A sessão fica salva na pasta `sessao/` (não precisa escanear de novo).

## Como funciona

- O robô escuta **todos os grupos** em que o chip está.
- Cada mensagem é enviada ao hub (`POST /api/demands`).
- O hub aplica um **pré-filtro**: conversa normal é descartada na hora.
- Mensagens relevantes (máquina parada, erro, pedido) viram **demanda** e a IA
  classifica (tipo, urgência, resumo, máquina) em segundo plano.
- Você acompanha tudo no hub, em **Demandas**.

## Vincular grupo a uma malharia (opcional)

Em `config.js`, no `grupoParaSistema`, mapeie o nome exato do grupo ao slug:

```js
grupoParaSistema: {
  'Operação Brusque': 'brusque',
  'JM Produção': 'jm',
}
```

Grupos não mapeados ficam na caixa geral (sem sistema).

## Deixar rodando sempre

Para o robô reiniciar sozinho se cair, use o **PM2**:

```bash
npm install -g pm2
pm2 start index.js --name robo-whatsapp
pm2 save
pm2 startup   # siga a instrução que aparecer (faz iniciar com o PC)
```

Ver logs: `pm2 logs robo-whatsapp` · Parar: `pm2 stop robo-whatsapp`
