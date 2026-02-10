import express, { Express, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import QRCode from 'qrcode';
import path from 'path';
import { log } from '../utils/logger';
import { EventEmitter } from 'events';

export interface WebServerEvents {
    'qr:generated': (qr: string) => void;
    'connection:update': (status: string) => void;
}

export class WebServer extends EventEmitter {
    private app: Express;
    private httpServer;
    private io: SocketIOServer;
    private port: number;
    private currentQR: string | null = null;
    private connectionStatus: string = 'disconnected';

    constructor(port: number = 3000) {
        super();
        this.port = port;
        this.app = express();
        this.httpServer = createServer(this.app);
        this.io = new SocketIOServer(this.httpServer);

        this.setupRoutes();
        this.setupSocketIO();
    }

    private setupRoutes(): void {
        // Serve static HTML
        this.app.get('/', (req: Request, res: Response) => {
            res.send(this.getHTML());
        });

        // API endpoint to get current QR code
        this.app.get('/api/qr', async (req: Request, res: Response) => {
            if (this.currentQR) {
                try {
                    const qrDataURL = await QRCode.toDataURL(this.currentQR);
                    res.json({ qr: qrDataURL, status: this.connectionStatus });
                } catch (error) {
                    res.status(500).json({ error: 'Failed to generate QR code' });
                }
            } else {
                res.json({ qr: null, status: this.connectionStatus });
            }
        });

        // API endpoint to get connection status
        this.app.get('/api/status', (req: Request, res: Response) => {
            res.json({ status: this.connectionStatus });
        });
    }

    private setupSocketIO(): void {
        this.io.on('connection', (socket) => {
            log.info('[WebServer] Client connected', { socketId: socket.id });

            // Send current state to new client
            if (this.currentQR) {
                QRCode.toDataURL(this.currentQR).then((qrDataURL) => {
                    socket.emit('qr', qrDataURL);
                });
            }
            socket.emit('status', this.connectionStatus);

            socket.on('disconnect', () => {
                log.info('[WebServer] Client disconnected', { socketId: socket.id });
            });
        });
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.httpServer.listen(this.port, () => {
                log.info(`[WebServer] Web interface available at http://localhost:${this.port}`);
                resolve();
            });
        });
    }

    async updateQR(qr: string): Promise<void> {
        this.currentQR = qr;
        try {
            const qrDataURL = await QRCode.toDataURL(qr);
            this.io.emit('qr', qrDataURL);
            log.info('[WebServer] QR code updated and sent to clients');
        } catch (error) {
            log.error('[WebServer] Failed to generate QR code', { error });
        }
    }

    updateStatus(status: string): void {
        this.connectionStatus = status;
        this.io.emit('status', status);
        log.info('[WebServer] Connection status updated', { status });

        // Clear QR code when connected
        if (status === 'connected') {
            this.currentQR = null;
            this.io.emit('qr', null);
        }
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            this.io.close();
            this.httpServer.close(() => {
                log.info('[WebServer] Web server stopped');
                resolve();
            });
        });
    }

    private getHTML(): string {
        return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Gateway - QR Code</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            padding: 40px;
            max-width: 500px;
            width: 100%;
            text-align: center;
        }
        
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        
        .status {
            display: inline-block;
            padding: 8px 20px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 14px;
            margin-bottom: 30px;
            transition: all 0.3s ease;
        }
        
        .status.disconnected {
            background: #fee;
            color: #c33;
        }
        
        .status.connecting {
            background: #ffeaa7;
            color: #d63031;
        }
        
        .status.connected {
            background: #d4edda;
            color: #155724;
        }
        
        #qr-container {
            background: #f8f9fa;
            border-radius: 15px;
            padding: 30px;
            margin: 20px 0;
            min-height: 300px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        #qr-code {
            max-width: 100%;
            height: auto;
            border-radius: 10px;
        }
        
        .loading {
            color: #667eea;
            font-size: 16px;
        }
        
        .instructions {
            background: #e3f2fd;
            border-left: 4px solid #2196f3;
            padding: 15px;
            border-radius: 5px;
            text-align: left;
            margin-top: 20px;
        }
        
        .instructions h3 {
            color: #1976d2;
            margin-bottom: 10px;
            font-size: 16px;
        }
        
        .instructions ol {
            margin-left: 20px;
            color: #555;
            font-size: 14px;
            line-height: 1.6;
        }
        
        .success-message {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            color: #155724;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
        }
        
        .success-message h3 {
            margin-bottom: 10px;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .loading {
            animation: pulse 1.5s ease-in-out infinite;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔗 WhatsApp Gateway</h1>
        <p class="subtitle">Conecte seu WhatsApp ao Asterisk</p>
        
        <div id="status-badge" class="status disconnected">Desconectado</div>
        
        <div id="qr-container">
            <div class="loading">Aguardando QR Code...</div>
        </div>
        
        <button id="refresh-btn" style="background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-bottom: 20px; font-size: 14px;">🔄 Atualizar QR Code</button>
        
        <div id="instructions" class="instructions" style="display: none;">
            <h3>📱 Como conectar:</h3>
            <ol>
                <li>Abra o WhatsApp no seu celular</li>
                <li>Toque em <strong>Menu (⋮)</strong> ou <strong>Configurações</strong></li>
                <li>Selecione <strong>Aparelhos conectados</strong></li>
                <li>Toque em <strong>Conectar um aparelho</strong></li>
                <li>Escaneie o QR Code acima</li>
            </ol>
        </div>
        
        <div id="success" class="success-message" style="display: none;">
            <h3>✅ Conectado com sucesso!</h3>
            <p>Seu WhatsApp está conectado e pronto para receber chamadas.</p>
        </div>
    </div>

    <script>
        const socket = io();
        const qrContainer = document.getElementById('qr-container');
        const statusBadge = document.getElementById('status-badge');
        const instructions = document.getElementById('instructions');
        const successMessage = document.getElementById('success');
        const refreshBtn = document.getElementById('refresh-btn');
        
        function updateQR(qrDataURL) {
            if (qrDataURL) {
                qrContainer.innerHTML = \`<img id="qr-code" src="\${qrDataURL}" alt="QR Code">\`;
                instructions.style.display = 'block';
                successMessage.style.display = 'none';
            } else {
                qrContainer.innerHTML = '<div class="loading">Aguardando QR Code...</div>';
                instructions.style.display = 'none';
            }
        }

        socket.on('qr', (qrDataURL) => {
            console.log('Received QR update via socket');
            updateQR(qrDataURL);
        });
        
        socket.on('status', (status) => {
            console.log('Received status update:', status);
            statusBadge.className = 'status ' + status;
            
            switch(status) {
                case 'disconnected':
                    statusBadge.textContent = '🔴 Desconectado';
                    break;
                case 'connecting':
                    statusBadge.textContent = '🟡 Conectando...';
                    break;
                case 'connected':
                    statusBadge.textContent = '🟢 Conectado';
                    qrContainer.innerHTML = '<div class="loading">✅ Conectado!</div>';
                    instructions.style.display = 'none';
                    successMessage.style.display = 'block';
                    break;
            }
        });
        
        function fetchStatusAndQR() {
            fetch('/api/qr')
                .then(res => res.json())
                .then(data => {
                    console.log('Manual fetch result:', data);
                    if (data.qr) updateQR(data.qr);
                    if (data.status) {
                        statusBadge.className = 'status ' + data.status;
                        if (data.status === 'connected') {
                            statusBadge.textContent = '🟢 Conectado';
                            qrContainer.innerHTML = '<div class="loading">✅ Conectado!</div>';
                            instructions.style.display = 'none';
                            successMessage.style.display = 'block';
                        }
                    }
                })
                .catch(err => console.error('Failed to fetch status:', err));
        }

        refreshBtn.addEventListener('click', fetchStatusAndQR);
        
        // Initial load
        fetchStatusAndQR();
    </script>
</body>
</html>
    `;
    }
}
