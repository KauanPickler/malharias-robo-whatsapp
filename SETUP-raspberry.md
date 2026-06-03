# Rodar o robô no Raspberry Pi 5 (24h, sem travar)

Guia para deixar o robô do WhatsApp rodando direto no Raspberry Pi 5, com
reinício automático e religando sozinho quando o Pi reinicia.

> ⚠️ Use SEMPRE um **chip dedicado** (não o pessoal). O `whatsapp-web.js` é
> não-oficial e o número pode ser banido.

---

## 1. Preparar o Raspberry (uma vez)

No terminal do Pi (ou via SSH):

```bash
# Atualiza o sistema
sudo apt update && sudo apt upgrade -y

# Chromium do sistema (o robô usa por baixo)
sudo apt install -y chromium-browser

# Node.js 20 LTS (ARM64)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Confere as versões
node -v        # deve mostrar v20.x
which chromium-browser   # confirma o caminho (normalmente /usr/bin/chromium-browser)
```

Se o `which chromium-browser` não retornar nada, tente `which chromium` e use
esse caminho no `config.js` (campo `chromiumPath`).

---

## 2. Baixar e configurar o robô

```bash
# Vai para a home e clona (ou copie a pasta do projeto pra cá)
cd ~
git clone <url-do-repositorio> malharias-robo-whatsapp
cd malharias-robo-whatsapp

# Instala dependências SEM baixar o Chromium do puppeteer (usamos o do sistema)
PUPPETEER_SKIP_DOWNLOAD=true npm install

# Cria o config a partir do exemplo
cp config.example.js config.js
nano config.js
```

No `config.js`, preencha:
- `hubUrl`: `https://malharia-hub.a3pprog.com.br`
- `ingestToken`: o token gerado no painel em **Robô & IA**
- `chromiumPath`: `/usr/bin/chromium-browser` (ou o que o `which` mostrou)

Salve (Ctrl+O, Enter, Ctrl+X).

> O resto (grupos, transcrição) é configurado no painel **Robô & IA** — o robô
> busca sozinho. Não precisa editar mais nada aqui.

---

## 3. Primeiro login (escanear o QR)

```bash
npm start
```

Vai aparecer um **QR code em ASCII** no terminal. No celular do **chip dedicado**:
WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie o QR.

Quando aparecer `🤖 Robô no ar!`, deu certo. Pare com **Ctrl+C** (a sessão fica
salva na pasta `sessao/`, não precisa escanear de novo).

---

## 4. Deixar rodando 24h com pm2

```bash
# Instala o gerenciador de processos
sudo npm install -g pm2

# Inicia o robô
pm2 start ecosystem.config.cjs

# Salva a lista de apps
pm2 save

# Faz o pm2 (e o robô) ligarem sozinhos quando o Pi reiniciar
pm2 startup
# ^ ele vai imprimir um comando "sudo env PATH=... pm2 startup systemd -u ...".
#   COPIE e EXECUTE esse comando que ele mostrar. Depois rode 'pm2 save' de novo.
pm2 save
```

Pronto! O robô roda 24h, reinicia sozinho se travar e volta quando o Pi liga.

---

## Comandos do dia a dia

```bash
pm2 status            # ver se está rodando
pm2 logs malharias-robo   # ver os logs (mensagens chegando, erros)
pm2 restart malharias-robo
pm2 stop malharias-robo
```

## Se o WhatsApp desconectar (raro)
```bash
pm2 logs malharias-robo   # se pedir QR de novo:
pm2 stop malharias-robo
npm start                 # escaneia o QR
# Ctrl+C e: pm2 restart malharias-robo
```

## Dicas
- Deixe o Pi com internet **estável** (cabo de rede é melhor que Wi-Fi).
- Não use o mesmo chip no celular ao mesmo tempo (pode deslogar o robô).
- O `ecosystem.config.cjs` reinicia o robô às 4h da manhã (boa prática).
