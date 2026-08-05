# Robô do WhatsApp — Malharias Hub

Escuta os grupos do WhatsApp (somente leitura) e envia as mensagens ao
Malharias Hub, que classifica com IA e registra como **demanda**.

## ⚠️ Aviso importante

Usa a biblioteca `Baileys` (não-oficial). Isso **pode violar os Termos de
Serviço do WhatsApp** e o número **pode ser banido**. Por isso:

- **Use SEMPRE um chip dedicado** (nunca seu número pessoal/da empresa).
- O robô **só lê, nunca envia** mensagens nos grupos (reduz o risco).
- Rode num PC que pode ficar ligado (o robô precisa estar de pé pra escutar).

## Pré-requisitos (no PC velho)

1. **Node.js 18+** — https://nodejs.org (versão LTS)
2. Acesso ao Malharias Hub para gerar o token do robô

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
A sessão fica salva na pasta `sessao-baileys/` (não precisa parear de novo).

## Controle pelo NexoK

O Malharias Hub fornece uma API privada para o aplicativo NexoK. Em
**Robô & IA → Controle pelo NexoK**, gere um token permanente e cadastre-o no
aplicativo. O token fica salvo somente como hash no servidor.

O aplicativo permite:

- consultar o estado do robô, WhatsApp e sites monitorados;
- visualizar logs operacionais e histórico de notificações;
- acompanhar alertas pendentes, retidos, enviados e com falha;
- usar o modo silencioso até reativação manual;
- programar o modo noturno (por padrão, 22:00–07:00);
- reconectar a sessão ou gerar um código de pareamento por telefone;
- reiniciar ou atualizar o processo remotamente.

## Failover assistido Cloudflare

O monitor acompanha Malharia Brusque, Pires Dashboard e Tecelagem JM. Depois de
três falhas consecutivas, ele envia no privado de um número autorizado uma
solicitação com código. O DNS só muda quando o administrador copia o comando
completo `CONFIRMAR FAILOVER ...`. O retorno à HostGator também exige três
verificações positivas e outro comando `CONFIRMAR RETORNO ...`.

O token precisa ter somente `Zone / DNS / Edit` e `Zone / Zone / Read`, limitado
à zona `a3pprog.com.br`. Configure-o no Raspberry sem enviá-lo ao Git:

```bash
export CLOUDFLARE_API_TOKEN='token_criado_na_cloudflare'
pm2 restart malharias-robo --update-env
```

Alternativamente, preencha `cloudflareFailover.apiToken` somente no `config.js`
local, que já é ignorado pelo Git. Use `status failover` no WhatsApp privado
para consultar o estado. Solicitações expiram em dez minutos e há intervalo
mínimo de quinze minutos entre trocas.

Durante o silêncio, o monitor continua funcionando e as filas não são
consumidas. As notificações pendentes voltam a ser enviadas quando o modo
Normal for retomado.

## Supervisor de máquinas

O robô consulta as leituras e os eventos dos dashboards e avisa no privado dos
administradores quando encontra uma máquina offline ou uma produção muito fora
do padrão das demais. O relatório cruza falhas, bloqueios e reinícios recentes
para indicar causas prováveis. Envie `relatório máquinas` no privado para ver a
última análise de todas as malharias.

Para evitar falsos positivos, a anomalia precisa aparecer em duas leituras
consecutivas. Por padrão, o supervisor roda a cada 15 minutos, considera offline
após 20 minutos sem dados e só compara produção quando existem ao menos três
máquinas ativas. O modo silencioso bloqueia integralmente esses avisos.

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
