import { WhatsAppClient, CallEvent } from '../whatsapp/client';
import { CallHandler } from '../whatsapp/call-handler';
import { SIPClient } from './client';
import { log } from '../utils/logger';
import { config } from '../config';
import { EventEmitter } from 'events';
import { MediaBridge } from '../media/bridge';
import { StunClient } from '../media/stun-client';
import { extractSrtpKeys, extractRelaysFromTransport } from '../media/key-extractor';

export class CallBridge extends EventEmitter {
    private activeBridges: Map<string, any> = new Map();
    private globalTransportToken: Buffer | undefined;

    constructor(private whatsappClient: WhatsAppClient, private callHandler: CallHandler, private sipClient: SIPClient) {
        super();
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        this.callHandler.on('call:incoming', async (call: CallEvent) => {
            log.info('[CallBridge] Nova chamada - Abrindo socket de mídia...');
            this.bridgeCall(call).catch(e => log.error('[CallBridge] Erro', e));
        });

        this.callHandler.on('call:transport', (node: any) => {
            const { relays: newRelays, globalToken } = extractRelaysFromTransport(node);

            if (globalToken) {
                log.info('[CallBridge] Captured Global Token from transport', { len: globalToken.length, hex: globalToken.toString('hex').slice(0, 50) + '...' });
                this.globalTransportToken = globalToken;
            }

            for (const b of this.activeBridges.values()) {
                // Merge new relays with existing ones to preserve tokens
                const currentRelays = b.mediaBridge.config.relayEndpoints || [];
                const fallbackToken = currentRelays.find((r: any) => r.token)?.token || this.globalTransportToken;

                const mergedRelays = newRelays.map(nr => {
                    const existing = currentRelays.find((cr: any) => cr.ip === nr.ip && cr.port === nr.port);
                    return {
                        ...nr,
                        token: nr.token || existing?.token || fallbackToken,
                        username: node.content?.[0]?.attrs?.['call-id'] || existing?.username || b.whatsappCall.callId,
                        callCreator: b.whatsappCall.from
                    };
                });

                // Only update if we have valid merged relays
                if (mergedRelays.length > 0) {
                    log.info('[CallBridge] Atualizando relays com tokens preservados:', { count: mergedRelays.length });
                    b.mediaBridge.updateRelays(mergedRelays);

                    mergedRelays.forEach((r: any) => {
                        if (r.token && r.username) {
                            // Send standard Binding Request (check conn)
                            b.stunClient.sendBindingRequest(r, r.username, r.token);

                            // Send USE-CANDIDATE Binding Request (nominate)
                            setTimeout(() => {
                                log.info('[CallBridge] Enviando USE-CANDIDATE nomination', { ip: r.ip });
                                b.stunClient.sendBindingRequest(r, r.username, r.token, true);
                            }, 100);
                        } else {
                            log.warn('[CallBridge] Relay sem token/username, nomination falhou', { ip: r.ip });
                        }
                    });
                }
            }
        });

        this.sipClient.on('call:established', (sid, rtp) => {
            for (const b of this.activeBridges.values()) {
                if (b.sipSessionId === sid) b.mediaBridge.updateAsteriskRtp(rtp.remoteRtpPort);
            }
        });

        this.callHandler.on('call:ended', (id) => this.endBridge(id));
    }

    private async bridgeCall(call: CallEvent): Promise<void> {
        const phoneNumber = call.from.split('@')[0];
        const sipSessionId = `wa-${call.callId.slice(-8)}`;

        const mediaBridge = new MediaBridge({
            localPort: config.rtp.portMin + Math.floor(Math.random() * 1000),
            asteriskHost: config.asterisk.host,
            asteriskRtpPort: 0
        });

        const stunClient = new StunClient();
        mediaBridge.setStunClient(stunClient);
        this.activeBridges.set(call.callId, { mediaBridge, stunClient, sipSessionId, whatsappCall: call });

        try {
            await mediaBridge.start();
            await stunClient.start(mediaBridge.getSocket()!);

            const keys = extractSrtpKeys(call.offer);
            if (keys) {
                await mediaBridge.initialize(keys);
                // Inject username/callId into relays for MediaBridge pokes
                const relaysWithAuth = keys.relayEndpoints.map(r => ({ ...r, username: call.callId }));
                mediaBridge.updateRelays(relaysWithAuth);
                relaysWithAuth.forEach(r => stunClient.sendBindingRequest(r, r.username, r.token));

                // Start silence injection to wake up the call timer
                mediaBridge.startSilence();
            }

            this.emit('bridge:created', { callId: call.callId, whatsappCall: call });
            this.callHandler.acceptCall(call.callId, call.from, call.callCreator).catch(() => { });

            const localPort = mediaBridge.getSocket()!.address().port;
            this.sipClient.makeCall(phoneNumber, sipSessionId, { localRtpPort: localPort }).catch(() => this.endBridge(call.callId));

        } catch (error) { this.endBridge(call.callId); }
    }

    private endBridge(callId: string): void {
        const b = this.activeBridges.get(callId);
        if (b) { b.mediaBridge.stop(); b.stunClient.stop(); this.activeBridges.delete(callId); this.emit('bridge:ended', { callId }); }
    }
}