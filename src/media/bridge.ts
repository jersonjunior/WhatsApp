import * as dgram from 'dgram';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { log } from '../utils/logger';
import { SrtpSession, RtpPacket, RtpHeader } from 'werift-rtp';

export class MediaBridge extends EventEmitter {
    private udpSocket: dgram.Socket | null = null;
    private srtpSession: SrtpSession | null = null;
    private authKeys: any = null; // Store keys for STUN fallback
    private activeRelay: { ip: string; port: number } | null = null;
    private stunClient: any = null;
    private keepAlive: NodeJS.Timeout | null = null;
    private packetsRx = 0;

    constructor(private config: any) { super(); }

    setStunClient(stun: any) { this.stunClient = stun; }

    async initialize(keys: any): Promise<void> {
        this.authKeys = keys;
        this.srtpSession = new SrtpSession({
            profile: 0x0001,
            keys: {
                localMasterKey: keys.masterKey, localMasterSalt: keys.masterSalt,
                remoteMasterKey: keys.masterKey, remoteMasterSalt: keys.masterSalt
            }
        });
        log.info('[MediaBridge] SRTP ativado');
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            const socket = dgram.createSocket('udp4');
            socket.on('message', (m, r) => this.demux(m, r));
            socket.once('listening', () => {
                this.udpSocket = socket;
                const addr = socket.address();
                const bindMsg = `[MediaBridge] UDP Socket bound to ${addr.address}:${addr.port}`;
                log.info(bindMsg);
                try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', bindMsg + '\n'); } catch (e) { }

                this.keepAlive = setInterval(() => this.poke(), 2000);
                resolve();
            });
            socket.bind(this.config.localPort);
        });
    }

    private poke() {
        const target = this.activeRelay || (this.config.relayEndpoints && this.config.relayEndpoints[0]);
        if (target && this.stunClient) {
            // Strategy: Try MULTIPLE combinations (Happy Eyeballs)

            // 1. Username = Call ID (Default)
            // @ts-ignore
            this.stunClient.sendBindingRequest(target, target.username, target.token);
            // @ts-ignore
            if (this.authKeys?.masterKey) this.stunClient.sendBindingRequest(target, target.username, this.authKeys.masterKey);

            // 2. Username = Call Creator (Caller JID)
            if (target.callCreator) {
                // @ts-ignore
                this.stunClient.sendBindingRequest(target, target.callCreator, target.token);
                // @ts-ignore
                if (this.authKeys?.masterKey) this.stunClient.sendBindingRequest(target, target.callCreator, this.authKeys.masterKey);
            }
        }
    }

    private demux(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        const first = msg[0];
        // Raw packet logging for debug
        const rawLog = `[MediaBridge] RAW RX len=${msg.length} Byte0=0x${first.toString(16)} from ${rinfo.address}:${rinfo.port}`;
        // log.debug(rawLog); 
        try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', rawLog + '\n'); } catch (e) { }

        if (first >= 0 && first <= 3) {
            const m = `[MediaBridge] STUN Packet RX (0x${first.toString(16)}) len=${msg.length}`;
            log.info(m);
            try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', m + '\n'); } catch (e) { }
            if (this.stunClient) this.stunClient.handleMessage(msg, rinfo);
        } else {
            this.handleMedia(msg, rinfo);
        }
    }

    private handleMedia(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        if (rinfo.address === this.config.asteriskHost) {
            if (this.config.asteriskRtpPort === 0) this.config.asteriskRtpPort = rinfo.port;
            this.forwardToWhatsApp(msg);
            return;
        }

        if (this.srtpSession) {
            try {
                const dec = this.srtpSession.decrypt(msg);
                if (dec) {
                    if (this.packetsRx++ === 0) log.info('[MediaBridge] ✅ Áudio descriptografado do WhatsApp!');

                    // Find matching relay to preserve auth info
                    const knownRelay = this.config.relayEndpoints?.find((r: any) => r.ip === rinfo.address && r.port === rinfo.port);
                    this.activeRelay = {
                        ip: rinfo.address,
                        port: rinfo.port,
                        // @ts-ignore
                        token: knownRelay?.token,
                        // @ts-ignore
                        username: knownRelay?.username
                    };

                    dec[1] = (dec[1] & 0x80) | 111;
                    this.udpSocket?.send(dec, this.config.asteriskRtpPort, this.config.asteriskHost);
                }
            } catch (e) { }
        }
    }

    private silenceInterval?: NodeJS.Timeout;
    private outSeq = 0;
    private outSsrc = 123456; // Fixed SSRC to maintain stream continuity
    private silenceTs = 0;

    startSilence(): void {
        if (this.silenceInterval) return;
        log.info('[MediaBridge] 🔇 Iniciando injeção de silêncio (Opus) para abrir áudio (SSRC: 123456)...');

        // Initial sequence number randomization (optional but good practice)
        if (this.outSeq === 0) this.outSeq = Math.floor(Math.random() * 0xFFFF);

        this.silenceInterval = setInterval(() => {
            // Se já recebemos áudio do Asterisk (forwarding), o stopSilence já devia ter sido chamado.
            // Mas por segurança, checa se srtpSession existe.
            if (!this.srtpSession) return;

            // Simple Silence Payload (Opus TOC=Config 31? Or maybe Config 12?)
            // [0xF8, 0xFF, 0xFE] is widely used "Silence".
            const payload = Buffer.from([0xF8, 0xFF, 0xFE]);

            this.sendRtp(payload, 111, this.silenceTs, true);
            this.silenceTs += 320; // 20ms @ 16khz
        }, 20);
    }

    stopSilence(): void {
        if (this.silenceInterval) {
            clearInterval(this.silenceInterval);
            this.silenceInterval = undefined;
            log.info('[MediaBridge] 🛑 Parando silêncio - Transição para áudio real.');
        }
    }

    private forwardToWhatsApp(msg: Buffer): void {
        this.stopSilence(); // Stop silence on first real packet

        if (!this.srtpSession) return;

        try {
            const pkt = RtpPacket.deSerialize(msg);

            // Debug incoming RTP format (Sample 1 in 100 packets)
            if (this.outSeq % 100 === 0) {
                log.info(`[MediaBridge] TX Audio (Asterisk -> WhatsApp) PT=${pkt.header.payloadType} Size=${pkt.payload.length}`);

                if (['0', '8', '18'].includes(pkt.header.payloadType.toString())) {
                    log.warn(`[MediaBridge] ⚠️ RTP Payload Type ${pkt.header.payloadType} (G.711/G.729) detected! WhatsApp expects OPUS (111). Transcoding needed!`);
                }
            }

            // Force PT=111 for WhatsApp Opus
            this.sendRtp(pkt.payload, 111, pkt.header.timestamp, pkt.header.marker);
        } catch (e) { }
    }

    private sendRtp(payload: Buffer, payloadType: number, timestamp: number, marker: boolean): void {
        const target = this.activeRelay;

        if (!target) {
            // Log only once per 100 packets to avoid spam
            if (this.outSeq % 100 === 0) log.warn('[MediaBridge] ⚠️ Cannot send RTP: STUN Handshake not completed (No Active Relay). Fix Relay Tokens!');
            return;
        }

        if (!this.srtpSession || !this.udpSocket) return;

        try {
            // Force PT=111 for Opus if needed, or respect input
            const validPt = (payloadType === 111 || payloadType === 0 || payloadType === 8 || payloadType === 96) ? payloadType : 111;

            const header = new RtpHeader({
                version: 2,
                padding: false,
                extension: false,
                marker: marker,
                payloadType: validPt,
                sequenceNumber: this.outSeq,
                timestamp: timestamp,
                ssrc: this.outSsrc
            });
            this.outSeq = (this.outSeq + 1) % 65535;

            // Encrypt
            // Note: werift srtpSession.encrypt returns { msg: Buffer, ... } or Buffer?
            // Assuming current usage `this.srtpSession.encrypt(packet.payload, packet.header)` returns Buffer based on previous code.
            const packet = new RtpPacket(header, payload);
            const encrypted = this.srtpSession.encrypt(packet.payload, packet.header);

            this.udpSocket.send(encrypted, target.port, target.ip);
        } catch (e) { }
    }

    updateAsteriskRtp(port: number) { this.config.asteriskRtpPort = port; }
    updateRelays(relays: any[]) { this.config.relayEndpoints = relays; }
    getSocket() { return this.udpSocket; }
    stop() {
        this.stopSilence();
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.udpSocket?.close();
    }
}