// Copie este arquivo para "config.js" e preencha com seus dados.
//
// IMPORTANTE: agora só precisa de hubUrl + ingestToken aqui. Todo o resto
// (mapeamento de grupos, transcrição de áudio/vídeo/imagem, grupos ignorados)
// é configurado no painel, em "Robô & IA", e o robô busca sozinho a cada 1 min.
//
// Os campos abaixo (grupoParaSistema, transcrever*, etc.) são apenas FALLBACK
// caso o hub esteja inacessível — pode deixá-los vazios.
export default {
  // URL do hub + token gerado no painel em "Robô & IA"
  hubUrl: 'https://malharia-hub.a3pprog.com.br',
  ingestToken: 'COLE_AQUI_O_TOKEN_DO_HUB',

  // No Raspberry Pi / Linux, use o Chromium do sistema (mais estável que o
  // baixado pelo puppeteer). Descubra o caminho com: which chromium-browser || which chromium
  // Deixe null no Windows/Mac (usa o do puppeteer).
  chromiumPath: '/usr/bin/chromium-browser',

  // --- Fallback local (o painel tem prioridade) ---
  grupoParaSistema: {
    // 'Nome do Grupo no WhatsApp': 'brusque',
  },
  ignorarGrupos: [],
  // Números (com DDD/55) que podem comandar o bot por mensagem privada.
  // Ex: ['5547999999999']. Melhor configurar no painel (Robô & IA).
  controleNumeros: [],
  apenasGrupos: true,
  transcreverAudio: true,
  transcreverVideo: false,
  transcreverImagem: false,
  maxMidiaMb: 16,
}
