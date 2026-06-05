#!/usr/bin/env bash
#
# Instalador do Robô do WhatsApp no Raspberry Pi.
# Uso (no terminal do Pi):
#   curl -fsSL https://raw.githubusercontent.com/KauanPickler/malharias-robo-whatsapp/main/install.sh -o install.sh && bash install.sh
#
set -e

echo "==================================================="
echo "  Instalando o Robô do WhatsApp — Malharias Hub"
echo "==================================================="

echo ""
echo "==> 1/5 Atualizando o sistema..."
sudo apt update -y

echo ""
echo "==> 2/5 Instalando Chromium e git..."
sudo apt install -y git || true
sudo apt install -y chromium-browser 2>/dev/null || sudo apt install -y chromium || true

echo ""
echo "==> 3/5 Instalando Node.js 20 (se necessário)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "Node: $(node -v 2>/dev/null || echo 'erro')"

echo ""
echo "==> 4/5 Baixando o robô..."
cd ~
if [ ! -d malharias-robo-whatsapp ]; then
  git clone https://github.com/KauanPickler/malharias-robo-whatsapp.git
fi
cd ~/malharias-robo-whatsapp
git pull || true
PUPPETEER_SKIP_DOWNLOAD=true npm install

echo ""
echo "==> 5/5 Configurando..."
[ -f config.js ] || cp config.example.js config.js

# Descobre o caminho do Chromium do sistema.
CHROME=$(command -v chromium-browser || command -v chromium || echo /usr/bin/chromium-browser)
sed -i "s#chromiumPath: '[^']*'#chromiumPath: '$CHROME'#" config.js || true

# Pede o token de ingestão e grava no config.js.
echo ""
echo "Cole o TOKEN de ingestão (pegue no painel: Robô & IA) e aperte Enter:"
read -r TOKEN
if [ -n "$TOKEN" ]; then
  sed -i "s#COLE_AQUI_O_TOKEN_DO_HUB#$TOKEN#" config.js
  echo "Token salvo."
fi

echo ""
echo "==================================================="
echo "  Pronto! Para escanear o QR e iniciar, rode:"
echo "     cd ~/malharias-robo-whatsapp && npm start"
echo ""
echo "  Depois de escanear o QR (com o chip dedicado),"
echo "  para deixar rodando 24h:"
echo "     sudo npm install -g pm2"
echo "     pm2 start ecosystem.config.cjs && pm2 save && pm2 startup"
echo "==================================================="
