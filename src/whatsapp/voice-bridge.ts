import dgram from 'dgram';
import { EventEmitter } from 'events';

export class VoiceBridge extends EventEmitter {
    private socket: dgram.Socket;
    private isRunning = false;

    private asteriskIp?: string;
    private asteriskPort?: number;

    private waIp?: string;
    private waPort?: number;

    private ssrcOut = Math.floor(Math.random() * 0xffffffff);
    private seq = 0;
    private timestamp = 0;

    private readonly payloadType = 111; // OPUS
    private readonly clockRate = 48000;
    private readonly frameSamples = 960; // 20ms OPUS

    constructor(private listenPort: number) {
        super();
        this.socket = dgram.createSocket('udp4');
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        this.socket.bind(this.listenPort);
        this.socket.on('message', this.onMessage.bind(this));
        console.log(`[MediaBridge] UDP Socket bound to 0.0.0.0:${this.listenPort}`);
    }

    stop() {
        this.isRunning = false;
        this.socket.close();
    }

    setAsteriskTarget(ip: string, port: number) {
        this.asteriskIp = ip;
        this.asteriskPort = port;
        console.log(`[MediaBridge] Asterisk target set to ${ip}:${port}`);
    }

    setWhatsAppTarget(ip: string, port: number) {
        this.waIp = ip;
        this.waPort = port;
        console.log(`[MediaBridge] WhatsApp target set to ${ip}:${port}`);
    }

    private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
        if (!this.isRunning) return;

        const isFromAsterisk =
            this.asteriskIp &&
            this.asteriskPort &&
            rinfo.address === this.asteriskIp &&
            rinfo.port === this.asteriskPort;

        const isFromWhatsApp =
            this.waIp &&
            this.waPort &&
            rinfo.address === this.waIp &&
            rinfo.port === this.waPort;

        if (isFromAsterisk) {
            // Asterisk → WhatsApp (repassa direto)
            if (this.waIp && this.waPort) {
                this.socket.send(msg, this.waPort, this.waIp);
            }
            return;
        }

        if (isFromWhatsApp) {
            // WhatsApp → Asterisk (reescreve RTP)
            if (!this.asteriskIp || !this.asteriskPort) return;

            const rtp = this.rewriteRtp(msg);
            if (rtp) {
                this.socket.send(rtp, this.asteriskPort, this.asteriskIp);
            }
            return;
        }
    }

    private rewriteRtp(packet: Buffer): Buffer | null {
        if (packet.length < 12) return null;

        const version = packet[0] >> 6;
        if (version !== 2) return null;

        // Ignora STUN
        if (packet[0] === 0x00 || packet[0] === 0x01) return null;

        const payload = packet.subarray(12);

        const out = Buffer.alloc(12 + payload.length);

        // RTP header
        out[0] = 0x80;                 // V=2
        out[1] = this.payloadType;     // OPUS
        this.seq = (this.seq + 1) & 0xffff;
        out.writeUInt16BE(this.seq, 2);

        this.timestamp += this.frameSamples;
        out.writeUInt32BE(this.timestamp >>> 0, 4);

        out.writeUInt32BE(this.ssrcOut >>> 0, 8);

        payload.copy(out, 12);

        return out;
    }
}
