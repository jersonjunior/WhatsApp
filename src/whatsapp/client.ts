import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    ConnectionState,
    BaileysEventMap,
    jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { encodeBinaryNode } from '@whiskeysockets/baileys/lib/WABinary'; // Import encoder
import { Boom } from '@hapi/boom';
import { log } from '../utils/logger';
import { displayQRCode } from '../utils/qrcode';
import { config } from '../config';
import { EventEmitter } from 'events';
import { decryptMessageNode } from '@whiskeysockets/baileys/lib/Utils/decode-wa-message';
import { makeLibSignalRepository } from '@whiskeysockets/baileys/lib/Signal/libsignal';
import { proto } from '@whiskeysockets/baileys/WAProto';

export interface CallEvent {
    callId: string;
    from: string;
    timestamp: number;
    isVideo: boolean;
    isGroup: boolean;
    offer?: any; // Decrypted offer containing keys and transport
    callCreator?: string;
}

export class WhatsAppClient extends EventEmitter {
    private sock: WASocket | null = null;
    private sessionDir: string;
    private webServer?: any; // WebServer instance
    private authState: any;
    public decryptedOffers: Map<string, any> = new Map(); // Store decrypted offers by Call ID
    private publicInfo: { ip: string, port: number } | null = null;

    private callState: Map<string, {
        gotTransport: boolean;
        gotRelay: boolean;
        accepted: boolean;
    }> = new Map();

    constructor(webServer?: any) {
        super();
        this.sessionDir = config.whatsapp.sessionDir + '_v2';
        this.webServer = webServer;
    }

    /**
     * Set detected public IP and port (from STUN)
     */
    setPublicInfo(ip: string, port: number): void {
        log.info('[WhatsApp] Setting public network info', { ip, port });
        this.publicInfo = { ip, port };
    }

    async connect(): Promise<void> {
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        this.authState = state;

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: require('pino')({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
        });

        // Connection state handler
        this.sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                log.info('[WhatsApp] QR Code received');
                displayQRCode(qr);

                // Send QR to web interface
                if (this.webServer) {
                    await this.webServer.updateQR(qr);
                    this.webServer.updateStatus('connecting');
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 405;

                log.warn('[WhatsApp] Connection closed', {
                    shouldReconnect,
                    statusCode,
                });

                // Update web interface
                if (this.webServer) {
                    this.webServer.updateStatus('disconnected');
                }

                if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
                    log.warn('[WhatsApp] Session expired or invalid. Clearing session and restarting...');

                    this.sock?.end(undefined);
                    this.sock = null;

                    // Clear auth_info directory with delay to ensure handles are closed
                    setTimeout(async () => {
                        const fs = require('fs');
                        try {
                            if (fs.existsSync(this.sessionDir)) {
                                fs.rmSync(this.sessionDir, { recursive: true, force: true });
                                log.info('[WhatsApp] Session directory cleared');
                            }
                        } catch (error) {
                            log.error('[WhatsApp] Failed to clear session directory', { error });
                        }

                        // Reconnect
                        this.connect();
                    }, 1000);
                } else if (shouldReconnect) {
                    log.info('[WhatsApp] Reconnecting...');
                    setTimeout(() => this.connect(), 2000); // Add small delay
                }
            } else if (connection === 'open') {
                log.info('[WhatsApp] Connection established successfully');

                if (this.webServer) {
                    this.webServer.updateStatus('connected');
                }

                this.emit('connected');

                // Hook into WebSocket for call sniffing
                this.setupCallSniffer();
            }
        });

        // Save credentials when updated
        this.sock.ev.on('creds.update', async (creds) => {
            log.info('[WhatsApp] Credentials updated', { keys: Object.keys(creds) });
            await saveCreds();
        });

        // Call event handler
        this.sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                console.log('[DEBUG] 🚨 RAW CALL EVENT RECEIVED:', call.id, call.status);
                log.info('[WhatsApp] Call event received', {
                    callId: call.id,
                    from: call.from,
                    status: call.status,
                    isVideo: call.isVideo,
                    isGroup: call.isGroup,
                });

                if (call.status === 'offer') {
                    let decryptedOffer = this.decryptedOffers.get(call.id);

                    log.info('[WhatsApp] Handling Call Offer', {
                        callId: call.id,
                        offerFound: !!decryptedOffer,
                        cachedOffers: this.decryptedOffers.size
                    });

                    // Wait a bit for the sniffer if needed (max 5 seconds)
                    if (!decryptedOffer) {
                        // Reduced retry loop for faster signaling
                        for (let i = 0; i < 3; i++) {
                            await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
                            decryptedOffer = this.decryptedOffers.get(call.id);
                            if (decryptedOffer) {
                                log.info('[WhatsApp] Found offer after retry', { callId: call.id, attempt: i + 1 });
                                break;
                            }
                        }
                    }

                    // Tenta extrair o IP público (RTE) da oferta confirmada
                    if (decryptedOffer) {
                        try {
                            const { extractRteFromOffer } = require('../media/key-extractor');
                            const rte = extractRteFromOffer(decryptedOffer);
                            if (rte) {
                                this.setPublicInfo(rte.ip, rte.port);
                            }
                        } catch (err) {
                            log.error('[WhatsApp] Failed to process RTE from offer', err);
                        }
                    }

                    // Final check: If still not found, we cannot proceed with audio
                    if (!decryptedOffer) {
                        log.error('[WhatsApp] Critical: Call offer not found in sniffer cache after retries. Audio will not be available.', {
                            callId: call.id,
                            availableInMap: Array.from(this.decryptedOffers.keys())
                        });
                    }

                    // Robust call creator extraction
                    const extractedCallCreator = decryptedOffer?._callCreator || decryptedOffer?.attrs?.['call-creator'];

                    const callEvent: CallEvent = {
                        callId: call.id,
                        from: decryptedOffer?._from || call.from, // CRITICAL: Use full JID with device suffix
                        callCreator: extractedCallCreator || call.from, // Robust fallback
                        timestamp: Date.now(),
                        isVideo: call.isVideo || false,
                        isGroup: call.isGroup || false,
                        offer: decryptedOffer // Attach decrypted offer if available
                    };

                    this.callState.set(call.id, {
                        gotTransport: false,
                        gotRelay: false, // Will become true when relaylatency is received
                        accepted: false
                    });

                    this.emit('call:offer', callEvent);

                    // Auto-send ringing + receipt
                    // NOTE: This does NOT mean accepting. It just means "I got the call".
                    await this.sendRinging(call.id, callEvent.from);
                    await this.sendCallReceipt(callEvent.from, call.id);

                    // Cleanup map for this call later
                    if (decryptedOffer) {
                        setTimeout(() => this.decryptedOffers.delete(call.id), 10000);
                    }
                } else if (call.status === 'ringing') {
                    this.emit('call:ringing', { callId: call.id });
                } else if (call.status === 'timeout' || call.status === 'reject' || call.status === 'accept') {
                    // Cleanup on end/accept
                    this.decryptedOffers.delete(call.id);
                    this.callState.delete(call.id);
                    this.emit(`call:${call.status}`, { callId: call.id });
                }
            }
        });
    }

    private setupCallSniffer() {
        if (this.sock && this.sock.ws) {
            log.info('[WhatsApp] Setting up Call Protocol Sniffer...');
            const originalOn = this.sock.ws.on.bind(this.sock.ws);

            // Direct listener for the binary node
            this.sock.ws.on('CB:call', async (node: any) => {
                const fs = require('fs');

                // 1. Send ACK immediately for EVERYTHING in the call class
                await this.sendCallAck(node);

                log.info('[WhatsApp] SNIFFER: Received call node', {
                    tag: node.tag,
                    attrs: node.attrs,
                    contentTags: Array.isArray(node.content) ? node.content.map((c: any) => c.tag) : typeof node.content
                });

                // 1. Dump raw
                fs.appendFileSync('call_dump.json', JSON.stringify(node, null, 2) + '\n---\n');

                // 2. Attempt Decryption
                try {
                    // Ensure transaction method exists on the keys object passed to repository
                    const signalKeys = {
                        ...this.authState.keys,
                        transaction: this.authState.keys.transaction || (async (cb: any) => cb())
                    };
                    const repository = makeLibSignalRepository({ ...this.authState, keys: signalKeys }, log as any, (async () => []) as any);

                    // Decrypt
                    // We use the me.id from creds. 
                    const meId = this.authState.creds.me.id;
                    const meLid = this.authState.creds.me.lid || meId; // Fallback if no LID

                    // Extract the offer node which contains the 'enc' node
                    const content = Array.isArray(node.content) ? node.content : [];
                    const offerNode = content.find((c: any) => c.tag === 'offer');

                    if (offerNode) {
                        const callId = offerNode.attrs['call-id'];

                        // Store the raw node as a baseline/fallback
                        // KeyExtractor can handle both raw nodes and decrypted protos
                        this.decryptedOffers.set(callId, offerNode);
                        log.info('[WhatsApp] SNIFFER: Raw Offer Stored (as fallback)', { callId });

                        const encNode = Array.isArray(offerNode.content)
                            ? offerNode.content.find((c: any) => c.tag === 'enc')
                            : null;

                        if (encNode) {
                            try {
                                const e2eType = encNode.attrs.type;
                                const remoteJid = offerNode.attrs['call-creator'];

                                // Decrypt manually
                                const msgBuffer = await repository.decryptMessage({
                                    jid: remoteJid,
                                    type: e2eType,
                                    ciphertext: encNode.content
                                });

                                // Save binary dump as JSON byte array because it might be binary
                                const decryptedData = {
                                    type: 'Buffer',
                                    data: Array.from(msgBuffer) // Convert Uint8Array to array for JSON serialization
                                };

                                // Try to parse the buffer as a Proto Message to inspect structure
                                // Try to produce a JSON representation
                                let finalOfferData: any = null;

                                // Try to parse the buffer as a Proto Message to inspect structure
                                try {
                                    const msg = proto.Message.decode(msgBuffer);
                                    finalOfferData = msg.toJSON();
                                    log.info('[WhatsApp] SNIFFER: Decrypted Offer Stored as Proto', {
                                        callId,
                                        callKeyPresent: !!finalOfferData.call?.callKey
                                    });
                                } catch (e) {
                                    log.warn('[WhatsApp] Failed to decode decrypted buffer as proto, storing raw', {
                                        error: (e as any).message,
                                        rawHex: Buffer.from(msgBuffer).toString('hex').substring(0, 100) + '...'
                                    });
                                    // Store as a custom object that KeyExtractor can recognize
                                    finalOfferData = {
                                        _isRawDecrypted: true,
                                        buffer: decryptedData
                                    };
                                }

                                if (finalOfferData) {
                                    // CRITICAL: Always use callId from offer attribute
                                    // Store with stanza ID for proper receipt signaling
                                    this.decryptedOffers.set(callId, {
                                        ...finalOfferData,
                                        _stanzaId: node.attrs.id,
                                        _from: node.attrs.from,
                                        _callCreator: offerNode.attrs['call-creator'],
                                        _rawHex: Buffer.from(msgBuffer).toString('hex') // FOR DIAGNOSTICS
                                    });
                                }

                                fs.appendFileSync('call_dump_decrypted.json', JSON.stringify(decryptedData, null, 2) + '\n---\n');
                                log.info('[WhatsApp] SNIFFER: Decrypted Call Node!', { size: msgBuffer.length });
                            } catch (decErr) {
                                log.error('[WhatsApp] SNIFFER: Decryption failed for enc node', decErr);
                            }
                        }
                    } else {
                        // log.warn('[WhatsApp] SNIFFER: No offer node found in call stanza');
                    }

                } catch (e) {
                    log.error('[WhatsApp] SNIFFER: Decryption failed', e);
                    fs.appendFileSync('call_dump_decrypted.json', `DECRYPTION FAILED: ${e}\n---\n`);
                }

                log.info('[WhatsApp] SNIFFER: CB:call PURE GOLD', {
                    structure: JSON.stringify(node, null, 2),
                    decryptedHex: this.decryptedOffers.get(node.content?.find((c: any) => c.tag === 'offer')?.attrs?.['call-id'])?._rawHex
                });
                this.emit('call:transport', node);
            });


            // Also listen for acknowledgments just in case
            this.sock.ws.on('CB:ack,class:call', (node: any) => {
                this.emit('call:ack', node);
            });
        } else {
            log.warn('[WhatsApp] Failed to setup sniffer: Socket not ready');
        }
    }

    /**
     * Helper to send node and log it for reverse engineering
     */
    private async sendNode(node: any): Promise<void> {
        if (!this.sock) return;

        const fs = require('fs');
        const timestamp = new Date().toISOString();
        const logEntry = `\n[${timestamp}] [OUT] ${node.tag}\n${JSON.stringify(node, null, 2)}\n`;
        try {
            fs.appendFileSync('packet_log.txt', logEntry);
        } catch (e) { }

        await this.sock.sendNode(node);
    }

    /**
     * Send ACK for incoming call messages (transport, relaylatency, etc.)
     */
    async sendCallAck(node: any): Promise<void> {
        if (!this.sock) return;

        const ackNode = {
            tag: 'ack',
            attrs: {
                id: node.attrs.id,
                to: node.attrs.from,
                class: node.tag,
            },
            content: undefined as any
        };

        // Add type from content tag if available
        if (node.tag === 'call' && Array.isArray(node.content) && node.content[0]?.tag) {
            ackNode.attrs = { ...ackNode.attrs, type: node.content[0].tag } as any;
        }

        log.debug('[WhatsApp] Sending ACK for call message', { nodeId: node.attrs.id, type: (ackNode.attrs as any).type });
        await this.sendNode(ackNode);
    }

    /**
     * Send preaccept signal - tells caller we're about to accept
     * This is required before sending the actual accept
     */
    async sendPreaccept(callId: string, from: string): Promise<void> {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }

        const validFrom = jidNormalizedUser(from);

        const preacceptNode = {
            tag: 'call',
            attrs: {
                id: this.sock.generateMessageTag(),
                to: from, // Use EXACT JID from offer
                v: '3',
                platform: 'android'
            },
            content: [
                {
                    tag: 'preaccept',
                    attrs: {
                        'call-creator': from, // Use the full JID from offer
                        'call-id': callId,
                        'v': '3',
                        'platform': 'android',
                        'device_class': '2016'
                    },
                    content: [
                        {
                            tag: 'audio',
                            attrs: {
                                enc: 'opus',
                                rate: '16000',
                                ptime: '20'
                            },
                        },
                        {
                            tag: 'audio',
                            attrs: {
                                enc: 'opus',
                                rate: '8000',
                                ptime: '20'
                            },
                        },
                        {
                            tag: 'video',
                            attrs: {
                                enc: 'none',
                            },
                        },
                        {
                            tag: 'net',
                            attrs: {
                                medium: '3',
                            },
                        },
                        {
                            tag: 'encopt',
                            attrs: {
                                keygen: '2',
                            },
                        },
                        {
                            tag: 'capability',
                            attrs: {
                                ver: '1',
                            },
                            content: new Uint8Array([1, 5, 247, 9, 228, 250, 19])
                        },
                    ],
                },
            ],
        };

        log.info('[WhatsApp] Sending PREACCEPT Stanza...', { callId });
        await this.sendNode(preacceptNode as any);
        this.emit('call:preaccept-sent', { callId });
    }

    /**
     * Send RINGING signal - tells caller that we have received the call
     */
    async sendRinging(callId: string, from: string): Promise<void> {
        if (!this.sock) return;

        const validFrom = jidNormalizedUser(from);

        const ringingNode = {
            tag: 'call',
            attrs: {
                id: this.sock.generateMessageTag(),
                to: from, // Use original JID
            },
            content: [
                {
                    tag: 'ringing',
                    attrs: {
                        'call-creator': from, // Use exact JID
                        'call-id': callId,
                        'v': '3',
                        'platform': 'android'
                    },
                },
            ],
        };

        log.info('[WhatsApp] Sending RINGING Stanza (Handled)...', { callId });
        await this.sendNode(ringingNode as any);
    }

    async acceptCall(callId: string, from: string, callCreator?: string): Promise<void> {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }

        const state = this.callState.get(callId);
        if (!state) {
            log.warn('[WhatsApp] acceptCall called but no callState found', { callId });
            // Even if state not found, proceed? No, assume broken flow.
            // But let's create a temp state to try anyway
        }

        // If already accepted, ignore
        if (state && state.accepted) {
            log.info('[WhatsApp] Call already accepted, skipping duplicate accept', { callId });
            return;
        }

        log.info('[WhatsApp] Starting ACCEPT flow (waiting for transport + relaylatency)...', { callId });

        // Step 1: Send preaccept first (using callCreator if available)
        await this.sendPreaccept(callId, from);

        // Step 2: WAIT for transport and relaylatency (with timeout)
        const timeoutMs = 8000;
        const start = Date.now();
        // Step 2: WAIT for transport - DISABLED to restore previous working behavior
        // Simply wait a fixed time to collect initial packets, then proceed regardless
        // This mimics the "blind accept" that worked before
        log.info('[WhatsApp] Waiting briefly for transport info before accepting...');
        await new Promise(resolve => setTimeout(resolve, 1500));

        /*
        while (true) {
            // Check state
            const currentState = this.callState.get(callId);
            
            // 'transport' messages come from SERVER/PEER. We respond to them.
            // We need to wait until we have enough info OR timeout.

            // Relaxed condition: If we got RelayLatency, we are good to go.
            // Some calls might not send explicit 'transport' node properly or we miss it.
            if (currentState && (currentState.gotRelay || currentState.gotTransport)) {
                log.info('[WhatsApp] Got required Transport OR Relay info. Proceeding to Accept.', { 
                    callId, 
                    gotTransport: currentState.gotTransport, 
                    gotRelay: currentState.gotRelay 
                });
                break;
            }

            if (Date.now() - start > timeoutMs) {
                log.warn('[WhatsApp] Timeout waiting for full transport/relay exchange. Accepting anyway (Force).', { callId, currentState });
                break;
            }

            // Wait 100ms
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        */


        // --- Dynamic TE Selection ---
        const acceptNode = {
            tag: 'call',
            attrs: {
                to: jidNormalizedUser(from),
                id: this.sock.generateMessageTag(),
            },
            content: [
                {
                    tag: 'accept',
                    attrs: {
                        'call-id': callId,
                        'call-creator': jidNormalizedUser(from),
                    },
                    content: [
                        {
                            tag: 'audio',
                            attrs: {
                                enc: 'opus',
                                rate: '16000',
                            },
                        },
                        {
                            tag: 'audio',
                            attrs: {
                                enc: 'opus',
                                rate: '8000',
                            },
                        },
                        {
                            tag: 'net',
                            attrs: {
                                medium: '3',
                            },
                        },
                        {
                            tag: 'encopt',
                            attrs: {
                                keygen: '2',
                            },
                        },
                        {
                            tag: 'capability',
                            attrs: {
                                ver: '1',
                            },
                            content: new Uint8Array([1, 5, 247, 9, 228, 250, 19])
                        },
                    ],
                },
            ],
        };

        log.info('[WhatsApp] Sending ACCEPT Stanza (Minimal/Clean)...', { callId });

        await this.sendNode(acceptNode as any);

        // Step 4: Send READY stanza to finalize connection
        await this.sendReady(callId, from);

        // Mark as accepted
        if (state) {
            state.accepted = true;
            this.callState.set(callId, state);
        }

        // Emit event to continue flow
        this.emit('call:accepted', { callId });
    }

    /**
     * Send relaylatency response - echoes back relay info with our measured latency
     * This is required after preaccept to participate in relay selection
     */
    async sendRelaylatency(callId: string, from: string, relayInfo?: any): Promise<void> {
        if (!this.sock) return;

        const validFrom = jidNormalizedUser(from);

        // Use a default relay if none provided (we'll measure actual ones later)
        const relayNode = {
            tag: 'call',
            attrs: {
                id: this.sock.generateMessageTag(),
                to: from, // Use exact JID
            },
            content: [
                {
                    tag: 'relaylatency',
                    attrs: {
                        'call-creator': from,
                        'call-id': callId,
                        'v': '3'
                    },
                    content: [
                        {
                            tag: 'te',
                            attrs: {
                                relay_name: relayInfo?.relay_name || 'gru1c02',
                                latency: relayInfo?.latency || '10',
                            },
                            content: relayInfo?.token || new Uint8Array([0, 0, 0, 0, 0, 0]),
                        },
                    ],
                },
            ],
        };

        log.info('[WhatsApp] Sending RELAYLATENCY response...', { callId });
        await this.sendNode(relayNode as any);
    }

    /**
     * Send READY signal - formalized the WebRTC/VoIP state machine
     */
    async sendReady(callId: string, from: string): Promise<void> {
        if (!this.sock) return;

        try {
            const readyNode = {
                tag: 'call',
                attrs: {
                    id: this.sock.generateMessageTag(),
                    to: from,
                    v: '3',
                    platform: 'android'
                },
                content: [
                    {
                        tag: 'ready',
                        attrs: {
                            'call-creator': from,
                            'call-id': callId,
                            'v': '3',
                            'platform': 'android',
                            'device_class': '2016'
                        },
                    },
                ],
            };

            log.info('[WhatsApp] Sending READY Stanza...', { callId });
            await this.sendNode(readyNode as any);
        } catch (error) {
            log.error('[WhatsApp] Failed to send READY', { callId, error });
        }
    }

    /**
     * Terminate the call
     */
    async terminateCall(callId: string, from: string, reason: string = 'hangup'): Promise<void> {
        if (!this.sock) return;

        const terminateNode = {
            tag: 'call',
            attrs: {
                id: this.sock.generateMessageTag(),
                to: from,
                v: '3',
                platform: 'android'
            },
            content: [
                {
                    tag: 'terminate',
                    attrs: {
                        'call-creator': from,
                        'call-id': callId,
                        'reason': reason
                    },
                },
            ],
        };

        log.info('[WhatsApp] Sending TERMINATE Stanza', { callId, reason });
        await this.sock.sendNode(terminateNode as any);
    }

    /**
     * Handle incoming transport message and send ACK + response
     */
    async handleTransportMessage(node: any): Promise<void> {
        if (!this.sock || !node.content) return;

        const from = node.attrs.from;
        let callId: string | undefined;

        // First, send ACK for the message
        await this.sendCallAck(node);

        // Iterate over ALL content items in the call stanza
        const contentItems = Array.isArray(node.content) ? node.content : [node.content];

        for (const item of contentItems) {
            const tag = item.tag;
            callId = item.attrs?.['call-id'] || callId;

            if (!callId) continue;

            const state = this.callState.get(callId);

            // For transport, we need to send transport response with our IP info
            if (tag === 'transport') {
                if (state) {
                    state.gotTransport = true;
                    this.callState.set(callId, state);
                }

                await this.sendTransportResponse(callId, from, item.attrs);

                // Also check for 'rte' node inside transport to get our public IP
                const rteNode = Array.isArray(item.content) ? item.content.find((c: any) => c.tag === 'rte') : (item.content?.tag === 'rte' ? item.content : null);
                if (rteNode) {
                    const endpoint = require('../media/key-extractor').parseRelayEndpoint(rteNode);
                    if (endpoint) {
                        log.info('[WhatsApp] Received Reflexive Transport Endpoint (RTE) from server', endpoint);
                        this.setPublicInfo(endpoint.ip, endpoint.port);
                    }
                }
            }

            // Handle relaylatency messages (pings from peer/server)
            if (tag === 'relaylatency') {
                if (state) {
                    state.gotRelay = true; // Mark that we received relay info (part of handshake)
                    this.callState.set(callId, state);
                }

                const teNodes = Array.isArray(item.content) ? item.content : [];

                if (teNodes.length > 0 && state) {
                    // Save the first relay TE node to use in our ACCEPT
                    // We want to "reflect" this relay back to the server as our chosen path
                    const bestTe = teNodes[0];
                    // Store raw node content (buffer) and attrs
                    (state as any).bestRelayTe = {
                        content: bestTe.content,
                        attrs: bestTe.attrs
                    };
                    this.callState.set(callId, state);

                    log.info('[WhatsApp] Captured Best Relay TE for ACCEPT', {
                        relay: bestTe.attrs?.relay_name
                    });
                }

                for (const te of teNodes) {
                    if (te.tag === 'te' || te.tag === 'te2') {
                        const relayInfo = {
                            relay_name: te.attrs?.relay_name,
                            latency: '10', // Claim low latency
                            token: te.content,
                        };
                        await this.sendRelaylatency(callId, from, relayInfo);
                    }
                }
            }

            // Handle standalone 'rte' if it exists
            if (tag === 'rte') {
                const endpoint = require('../media/key-extractor').parseRelayEndpoint(item);
                if (endpoint) {
                    log.info('[WhatsApp] Received standalone RTE from server', endpoint);
                    this.setPublicInfo(endpoint.ip, endpoint.port);
                }
            }
        }
    }

    /**
     * Send transport response with our network candidate info
     */
    async sendTransportResponse(callId: string, from: string, transportAttrs: any): Promise<void> {
        if (!this.sock) return;

        const validFrom = jidNormalizedUser(from);

        // Use dynamic config or STUN info
        const signaledIp = this.publicInfo?.ip || config.network.publicIp;
        const signaledPort = (this.publicInfo?.port || config.rtp.portMin).toString();

        const transportNode = {
            tag: 'call',
            attrs: {
                id: this.sock.generateMessageTag(),
                to: from, // Use original JID
            },
            content: [
                {
                    tag: 'transport',
                    attrs: {
                        'call-creator': from,
                        'call-id': callId,
                        'p2p-cand-round': transportAttrs?.['p2p-cand-round'] || '1',
                        'transport-message-type': '2', // Response type
                        'v': '3'
                    },
                    content: [
                        {
                            tag: 'net',
                            attrs: {
                                protocol: '0',
                                medium: '3', // WiFi
                            },
                        },
                        {
                            tag: 'cand',
                            attrs: {
                                ip: signaledIp,
                                port: signaledPort,
                                type: 'host',
                                protocol: 'udp',
                                foundation: '1',
                                component: '1',
                                priority: '2130706431',
                            },
                        },
                    ],
                },
            ],
        };

        log.info('[WhatsApp] Sending TRANSPORT response...', { callId });
        await this.sock.sendNode(transportNode as any);
    }

    async sendCallReceipt(from: string, callId: string): Promise<void> {
        if (this.sock) {
            try {
                // Determine the correct stanza ID to acknowledge
                const offerData = this.decryptedOffers.get(callId);
                const stanzaId = offerData?._stanzaId || this.sock.generateMessageTag();

                // Send a proper receipt node for the call offer
                // This stops the "Ringing" timeout on the caller side
                const receiptNode = {
                    tag: 'receipt',
                    attrs: {
                        to: from,
                        id: stanzaId,
                        class: 'call'
                    }
                    // No content needed for basic receipt
                };

                log.info('[WhatsApp] Sending CALL Receipt...', { from, callId, stanzaId });
                await this.sock.sendNode(receiptNode as any);
            } catch (e) {
                log.error('Failed to send call receipt', e);
            }
        }
    }

    async rejectCall(callId: string, from: string): Promise<void> {
        if (!this.sock) throw new Error('WhatsApp socket not initialized');

        log.info('[WhatsApp] Rejecting call', { callId, from });

        try {
            await this.sock.rejectCall(callId, from);
            this.emit('call:rejected', { callId });
        } catch (error) {
            log.error('[WhatsApp] Failed to reject call', { callId, error });
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.sock) {
            log.info('[WhatsApp] Closing connection (keeping session)...');
            this.sock.end(undefined);
            this.sock = null;
        }
    }

    getSocket(): WASocket | null {
        return this.sock;
    }

    getAuthState(): any {
        return this.authState;
    }

    isConnected(): boolean {
        return this.sock !== null;
    }

    getDecryptedOffer(callId: string): any {
        return this.decryptedOffers.get(callId);
    }
}
