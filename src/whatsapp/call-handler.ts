import { WhatsAppClient, CallEvent } from './client';
import { log } from '../utils/logger';
import { EventEmitter } from 'events';

export interface CallHandlerEvents {
    'call:incoming': (call: CallEvent) => void;
    'call:accepted': (callId: string) => void;
    'call:rejected': (callId: string) => void;
    'call:ended': (callId: string) => void;
    'call:transport': (data: any) => void;
}

export class CallHandler extends EventEmitter {
    private whatsappClient: WhatsAppClient;
    private activeCalls: Map<string, CallEvent> = new Map();

    constructor(whatsappClient: WhatsAppClient) {
        super();
        this.whatsappClient = whatsappClient;
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        /**
         * 📞 Oferta de chamada recebida
         */
        this.whatsappClient.on('call:offer', async (call: CallEvent) => {
            log.info('[CallHandler] Incoming call', {
                from: call.from,
                callId: call.callId,
                isVideo: call.isVideo,
            });

            this.activeCalls.set(call.callId, call);
            this.activeCalls.set(call.callId, call);

            // Re-enabled for Asterisk Bridging
            this.emit('call:incoming', call);

            // 1️⃣ Enviar RINGING para tirar "verificando..." do chamador
            await this.whatsappClient.sendRinging(call.callId, call.from);
            await this.whatsappClient.sendCallReceipt(call.from, call.callId);

            // ❌ Rejeitar chamadas de vídeo
            if (call.isVideo) {
                log.info('[CallHandler] Rejecting video call', { callId: call.callId });
                await this.rejectCall(call.callId, call.from);
                return;
            }

            // 2️⃣ Auto-aceitar imediatamente (DESATIVADO - DELEGADO PARA CALLBRIDGE)
            /*
            log.info('[CallHandler] Auto-accepting call immediately to validate signaling', { callId: call.callId });
            try {
                // Pass all required arguments: ID, From, and Creator
                await this.acceptCall(call.callId, call.from, call.callCreator);
            } catch (err) {
                log.error('[CallHandler] Auto-accept failed', err);
            }
            */
        });

        /**
         * 🔔 Evento de ringing (do lado remoto)
         */
        this.whatsappClient.on('call:ringing', ({ callId }: { callId: string }) => {
            log.info('[CallHandler] Call ringing (remote)', { callId });
        });

        /**
         * ⏱️ Timeout da chamada
         */
        this.whatsappClient.on('call:timeout', ({ callId }: { callId: string }) => {
            log.warn('[CallHandler] Call timeout', { callId });
            this.activeCalls.delete(callId);
            this.emit('call:ended', callId);
        });

        /**
         * 🔄 Transporte / negociação de mídia
         */
        this.whatsappClient.on('call:transport', async (data: any) => {
            log.debug('[CallHandler] Call transport data received', { data });
            await this.whatsappClient.handleTransportMessage(data);
            this.emit('call:transport', data);
        });

        /**
         * 📩 ACKs
         */
        this.whatsappClient.on('call:ack', (data: any) => {
            log.debug('[CallHandler] Call acknowledgment received', { data });
        });

        /**
         * ❌ Rejeição explícita
         */
        this.whatsappClient.on('call:reject', ({ callId }: { callId: string }) => {
            log.info('[CallHandler] Call rejected by remote', { callId });
            this.activeCalls.delete(callId);
            this.emit('call:rejected', callId);
        });

        /**
         * ✅ Aceitação confirmada
         */
        this.whatsappClient.on('call:accept', ({ callId }: { callId: string }) => {
            log.info('[CallHandler] Call accepted (remote confirmed)', { callId });
        });

        /**
         * 📴 Chamada finalizada
         */
        this.whatsappClient.on('call:ended', ({ callId }: { callId: string }) => {
            log.info('[CallHandler] Call ended', { callId });
            this.activeCalls.delete(callId);
            this.emit('call:ended', callId);
        });
    }

    /**
     * ✅ Aceita chamada no WhatsApp
     */
    async acceptCall(callId: string, from?: string, callCreator?: string): Promise<void> {
        try {
            const call = this.activeCalls.get(callId);
            if (!call && !from) {
                log.warn('[CallHandler] Cannot accept call - not found', { callId });
                return;
            }

            const remoteJid = from || call?.from;
            // Fallback to remoteJid if creator is missing, to avoid protocol errors
            const creator = callCreator || call?.callCreator || remoteJid;

            if (!remoteJid) throw new Error('Remote JID missing for acceptCall');

            await this.whatsappClient.acceptCall(callId, remoteJid, creator);

            log.info('[CallHandler] Call accepted successfully', { callId });
            this.emit('call:accepted', callId);
        } catch (error) {
            log.error('[CallHandler] Failed to accept call', { callId, error });
            throw error;
        }
    }

    /**
     * ❌ Rejeita chamada
     */
    async rejectCall(callId: string, from: string): Promise<void> {
        try {
            await this.whatsappClient.rejectCall(callId, from);
            log.info('[CallHandler] Call rejected successfully', { callId });
            this.activeCalls.delete(callId);
            this.emit('call:rejected', callId);
        } catch (error) {
            log.error('[CallHandler] Failed to reject call', { callId, error });
            throw error;
        }
    }

    /**
     * 📴 Finaliza chamada localmente e envia sinal para WhatsApp
     */
    async endCall(callId: string, from?: string): Promise<void> {
        log.info('[CallHandler] Ending call routine', { callId });

        const call = this.activeCalls.get(callId);
        const remoteJid = from || call?.from;

        if (remoteJid) {
            try {
                await this.whatsappClient.terminateCall(callId, remoteJid);
            } catch (error) {
                log.error('[CallHandler] Failed to send terminate stanza', { callId, error });
            }
        } else {
            log.warn('[CallHandler] Could not send terminate: remote JID unknown', { callId });
        }

        this.activeCalls.delete(callId);
        this.emit('call:ended', callId);
    }

    getActiveCall(callId: string): CallEvent | undefined {
        return this.activeCalls.get(callId);
    }

    getAllActiveCalls(): CallEvent[] {
        return Array.from(this.activeCalls.values());
    }
}
