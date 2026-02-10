import { WhatsAppClient } from './whatsapp/client';
import { CallHandler } from './whatsapp/call-handler';
import { SIPClient } from './sip/client';
import { CallBridge } from './sip/call-bridge';
import { WebServer } from './web/server';
import { config, validateConfig } from './config';
import { log } from './utils/logger';

// Force request to accept self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

class WhatsAppAsteriskGateway {
    private webServer: WebServer;
    private whatsappClient: WhatsAppClient;
    private callHandler: CallHandler;
    private sipClient: SIPClient;
    private callBridge: CallBridge;
    private isRunning: boolean = false;

    constructor() {
        this.webServer = new WebServer(3000);
        this.whatsappClient = new WhatsAppClient(this.webServer);
        this.callHandler = new CallHandler(this.whatsappClient);
        this.sipClient = new SIPClient();
        this.callBridge = new CallBridge(
            this.whatsappClient,
            this.callHandler,
            this.sipClient
        );
    }

    async start(): Promise<void> {
        try {
            log.info('='.repeat(60));
            log.info('WhatsApp to Asterisk Voice Gateway');
            log.info('='.repeat(60));

            // Validate configuration
            log.info('[Gateway] Validating configuration...');
            validateConfig();
            log.info('[Gateway] Configuration validated successfully');

            // Start web server
            log.info('[Gateway] Starting web interface...');
            await this.webServer.start();
            log.info('[Gateway] Web interface started at http://localhost:3000');

            // Connect to WhatsApp
            log.info('[Gateway] Connecting to WhatsApp...');
            await this.whatsappClient.connect();

            // Wait for WhatsApp connection
            await new Promise<void>((resolve) => {
                this.whatsappClient.once('connected', () => {
                    log.info('[Gateway] WhatsApp connected successfully');
                    resolve();
                });
            });

            // Connect to Asterisk SIP
            log.info('[Gateway] Connecting to Asterisk SIP...');
            try {
                // Connect sends OPTIONS ping and waits for response
                await this.sipClient.connect();
                log.info('[Gateway] SIP transport initialized and verified');
            } catch (error) {
                log.warn('[Gateway] Failed to connect to Asterisk SIP (continuing with WhatsApp only)', { error });
            }

            // Setup bridge event listeners
            this.setupBridgeListeners();

            this.isRunning = true;
            log.info('='.repeat(60));
            log.info('[Gateway] Gateway is ready and listening for calls');
            log.info('='.repeat(60));
        } catch (error) {
            log.error('[Gateway] Failed to start gateway', { error });
            throw error;
        }
    }

    private setupBridgeListeners(): void {
        this.callBridge.on('bridge:created', (bridge) => {
            log.info('[Gateway] Call bridge created', {
                callId: bridge.callId,
                from: bridge.whatsappCall.from,
            });
        });

        this.callBridge.on('bridge:established', (sessionId) => {
            log.info('[Gateway] Call bridge established', { sessionId });
        });

        this.callBridge.on('bridge:ended', (bridge) => {
            const duration = bridge.endTime
                ? ((bridge.endTime - bridge.startTime) / 1000).toFixed(2)
                : 'unknown';

            log.info('[Gateway] Call bridge ended', {
                callId: bridge.callId,
                duration: `${duration}s`,
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        log.info('[Gateway] Shutting down gateway...');

        try {
            // Disconnect SIP
            await this.sipClient.disconnect();
            log.info('[Gateway] SIP disconnected');

            // Disconnect WhatsApp
            await this.whatsappClient.disconnect();
            log.info('[Gateway] WhatsApp disconnected');

            // Stop web server
            await this.webServer.stop();
            log.info('[Gateway] Web server stopped');

            this.isRunning = false;
            log.info('[Gateway] Gateway stopped successfully');
        } catch (error) {
            log.error('[Gateway] Error during shutdown', { error });
            throw error;
        }
    }
}

// Main entry point
async function main() {
    const gateway = new WhatsAppAsteriskGateway();

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
        log.info(`[Main] Received ${signal}, shutting down gracefully...`);
        try {
            await gateway.stop();
            process.exit(0);
        } catch (error) {
            log.error('[Main] Error during shutdown', { error });
            process.exit(1);
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        log.error('[Main] Uncaught exception', { error });
        shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
        log.error('[Main] Unhandled rejection', { reason, promise });
        shutdown('unhandledRejection');
    });

    // Start the gateway
    try {
        await gateway.start();
    } catch (error) {
        log.error('[Main] Failed to start gateway', { error });
        process.exit(1);
    }
}

// Run the application
main();
