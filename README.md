# WhatsApp to Asterisk Voice Gateway

Sistema que integra chamadas de voz do WhatsApp com tronco PJSIP do Asterisk, permitindo receber chamadas do WhatsApp e encaminhá-las para o Asterisk.

## 🎯 Funcionalidades

- ✅ Autenticação WhatsApp via QR Code
- ✅ Persistência de sessão WhatsApp
- ✅ Detecção automática de chamadas recebidas
- ✅ Aceitação automática de chamadas de voz
- ✅ Rejeição automática de chamadas de vídeo
- ✅ Integração com Asterisk via SIP/PJSIP
- ✅ Bridge de chamadas WhatsApp → Asterisk
- ✅ Logging estruturado
- ⏳ Bridge de áudio WebRTC ↔ RTP (em desenvolvimento)

## 📋 Pré-requisitos

- Node.js 18+ e npm
- Servidor Asterisk com PJSIP configurado
- Número WhatsApp dedicado para o gateway

## 🚀 Instalação

```bash
# Clonar ou navegar para o diretório
cd C:\Users\Jr\Desktop\WhatsApp

# Instalar dependências
npm install

# Copiar arquivo de configuração
copy .env.example .env

# Editar .env com suas credenciais do Asterisk
notepad .env
```

## ⚙️ Configuração

### 1. Configurar .env

Edite o arquivo `.env` com as credenciais do seu Asterisk:

```env
# Asterisk PJSIP Configuration
ASTERISK_HOST=192.168.1.100          # IP do servidor Asterisk
ASTERISK_PORT=5060                    # Porta SIP
ASTERISK_USER=whatsapp_trunk          # Usuário SIP
ASTERISK_PASSWORD=sua_senha_aqui      # Senha SIP
ASTERISK_REALM=asterisk.local         # Realm SIP
ASTERISK_CONTEXT=from-whatsapp        # Contexto do dialplan

# SIP Transport
SIP_TRANSPORT=UDP                     # UDP, TCP ou TLS

# RTP Configuration
RTP_PORT_MIN=10000
RTP_PORT_MAX=20000

# Logging
LOG_LEVEL=debug                       # debug, info, warn, error
LOG_FILE=./logs/gateway.log

# Configure o .env para usar WebSocket:
ASTERISK_PORT=8088
SIP_TRANSPORT=ws
```

### 2. Configurar Asterisk PJSIP (WebSocket Obrigatório)

O gateway utiliza `SIP.js` que requer transporte WebSocket (WSS/WS). **Não é possível usar UDP/5060 diretamente.**

1. Habilite o WebSocket no Asterisk (`http.conf`):
```ini
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
```

2. Configure o transporte WebSocket (`pjsip.conf`):
```ini
[transport-ws]
type=transport
protocol=ws
bind=0.0.0.0:8088

[whatsapp_gateway]
type=endpoint
transport=transport-ws
context=from-whatsapp
disallow=all
allow=ulaw
allow=alaw
auth=whatsapp_gateway_auth
aors=whatsapp_gateway_aor
; ... restante da configuração
```

### 3. Configurar Dialplan

Adicione ao arquivo `extensions.conf`:

```ini
[from-whatsapp]
exten => _X.,1,NoOp(Incoming call from WhatsApp: ${CALLERID(num)})
 same => n,Dial(SIP/ramal_destino,30)
 same => n,Hangup()
```

## 🏃 Executar

### Modo Desenvolvimento

```bash
npm run dev
```

### Modo Produção

```bash
# Compilar TypeScript
npm run build

# Executar
npm start
```

## 📱 Primeira Execução

1. Execute o gateway:
   ```bash
   npm run dev
   ```

2. Um QR Code será exibido no terminal

3. Abra o WhatsApp no celular:
   - Android: Menu (⋮) → Aparelhos conectados → Conectar um aparelho
   - iPhone: Configurações → Aparelhos conectados → Conectar um aparelho

4. Escaneie o QR Code

5. Aguarde a mensagem: `[Gateway] Gateway is ready and listening for calls`

## 📞 Testando

1. Com o gateway rodando e autenticado
2. De outro telefone, faça uma chamada de voz para o número WhatsApp conectado
3. O gateway irá:
   - Detectar a chamada
   - Aceitar automaticamente
   - Criar uma chamada SIP para o Asterisk
   - Encaminhar conforme o dialplan

## 📊 Logs

Os logs são salvos em:
- Console: Saída colorida e formatada
- Arquivo: `./logs/gateway.log` (rotação automática)

Exemplo de logs:

```
2026-02-07 13:00:00 [info]: [Gateway] WhatsApp connected successfully
2026-02-07 13:00:01 [info]: [Gateway] SIP registered successfully
2026-02-07 13:00:02 [info]: [Gateway] Gateway is ready and listening for calls
2026-02-07 13:05:00 [info]: [WhatsApp] Call event received
2026-02-07 13:05:00 [info]: [CallHandler] Incoming call from +5511999999999
2026-02-07 13:05:01 [info]: [CallBridge] Creating bridge
2026-02-07 13:05:02 [info]: [SIP] Initiating call to Asterisk
2026-02-07 13:05:03 [info]: [Gateway] Call bridge established
```

## 🔧 Troubleshooting

### QR Code não aparece

- Verifique se a pasta `auth_info/` está vazia
- Delete `auth_info/` e execute novamente

### Erro de conexão SIP

- Verifique IP, porta e credenciais no `.env`
- Teste conectividade: `telnet <ASTERISK_HOST> 5060`
- Verifique firewall do Asterisk

### Chamada não chega no Asterisk

- Verifique logs do Asterisk: `asterisk -rx "pjsip show endpoints"`
- Verifique dialplan: `asterisk -rx "dialplan show from-whatsapp"`
- Ative debug SIP: `asterisk -rx "pjsip set logger on"`

### Erro "Cannot find module"

```bash
# Reinstalar dependências
rm -rf node_modules package-lock.json
npm install
```

## 🏗️ Arquitetura

```
WhatsApp Call → Baileys Client → Call Handler → Call Bridge → SIP Client → Asterisk
                                                      ↓
                                                 Audio Bridge
                                                      ↓
                                              WebRTC ↔ RTP
```

### Módulos

- **WhatsApp Client** (`src/whatsapp/client.ts`): Conexão e autenticação
- **Call Handler** (`src/whatsapp/call-handler.ts`): Gerenciamento de chamadas
- **SIP Client** (`src/sip/client.ts`): Conexão com Asterisk
- **Call Bridge** (`src/sip/call-bridge.ts`): Bridge WhatsApp ↔ Asterisk
- **Config** (`src/config/index.ts`): Configuração centralizada
- **Logger** (`src/utils/logger.ts`): Logging estruturado

## ⚠️ Limitações Atuais

1. **Áudio**: O bridge de áudio WebRTC ↔ RTP ainda não está implementado
   - Chamadas são aceitas e encaminhadas ao Asterisk
   - Áudio não é transmitido (em desenvolvimento)

2. **Vídeo**: Chamadas de vídeo são automaticamente rejeitadas

3. **Protocolo WhatsApp**: A API de chamadas do Baileys é limitada
   - Aceitação de chamadas funciona parcialmente
   - Extração de parâmetros WebRTC requer análise do protocolo binário

## 🔮 Próximos Passos

1. Implementar bridge de áudio WebRTC ↔ RTP
2. Adicionar suporte a codec Opus
3. Implementar conversão Opus → G.711
4. Testar qualidade de áudio
5. Adicionar suporte a chamadas de vídeo (opcional)

## 📄 Licença

MIT

## 🤝 Contribuindo

Este é um projeto experimental. Contribuições são bem-vindas!

## ⚖️ Disclaimer

Este projeto não é afiliado, associado, autorizado ou endossado pelo WhatsApp ou Meta. Use por sua conta e risco.
