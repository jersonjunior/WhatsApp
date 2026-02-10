import * as dgram from 'dgram';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { log } from '../utils/logger';
import { EventEmitter } from 'events';

const STUN_MAGIC_COOKIE = 0x2112A442;
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;

// CRC32 Implementation for STUN FINGERPRINT
const CRC32_TABLE: number[] = new Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC32_TABLE[i] = c >>> 0;
}
function crc32(buf: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class StunClient extends EventEmitter {
    private socket: dgram.Socket | null = null;

    async start(socket: dgram.Socket): Promise<void> {
        this.socket = socket;
        log.info('[STUN] Multiplexador pronto (com FINGERPRINT)');
    }

    handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        const type = msg.readUInt16BE(0);
        // 0x0101 = Binding Success, 0x0111 = Binding Error
        if (type === 0x0101) {
            const m = `[STUN] ✅ Binding Success Response from ${rinfo.address}!`;
            log.info(m);
            try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', m + '\n'); } catch (e) { }
            this.emit('binding-success', rinfo);
        } else if (type === 0x0111) {
            const errCode = msg.length > 20 ? msg.readUInt16BE(20 + 4 + 2) : 'unknown';
            const m = `[STUN] ❌ Binding Error Response from ${rinfo.address} (Type: 0x${type.toString(16)}) ErrorCode: ${errCode}`;
            log.warn(m);
            try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', m + '\n'); } catch (e) { }
        } else {
            // Log only relevant STUN types to avoid noise
            if (type < 0x0200) { // STUN Method
                const m = `[STUN] RX Type: 0x${type.toString(16)} form ${rinfo.address}`;
                log.debug(m);
                try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', m + '\n'); } catch (e) { }
            }
        }
    }

    sendBindingRequest(relay: any, username?: string, token?: Buffer, useCandidate: boolean = false): void {
        if (!this.socket) return;

        const m = `[STUN] TX Binding Request to ${relay.ip}:${relay.port} (User: ${username}, TokenLen: ${token?.length}, UseCand: ${useCandidate})`;
        try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', m + '\n'); } catch (e) { }

        const transactionId = crypto.randomBytes(12);
        const header = Buffer.alloc(20);
        header.writeUInt16BE(STUN_BINDING_REQUEST, 0);

        const attrs: Buffer[] = [];

        // 1. USERNAME (0x0006)
        if (username) {
            const uBuf = Buffer.from(username);
            const pad = (4 - (uBuf.length % 4)) % 4;
            const attr = Buffer.alloc(4 + uBuf.length + pad);
            attr.writeUInt16BE(0x0006, 0);
            attr.writeUInt16BE(uBuf.length, 2);
            uBuf.copy(attr, 4);
            attrs.push(attr);
        }

        // 2. ICE-CONTROLLED (0x8029)
        {
            const attr = Buffer.alloc(12);
            attr.writeUInt16BE(0x8029, 0);
            attr.writeUInt16BE(8, 2);
            crypto.randomBytes(8).copy(attr, 4);
            attrs.push(attr);
        }

        // 3. PRIORITY (0x0024)
        {
            const attr = Buffer.alloc(8);
            attr.writeUInt16BE(0x0024, 0);
            attr.writeUInt16BE(4, 2);
            attr.writeUInt32BE(1845494271, 4);
            attrs.push(attr);
        }

        // 4. USE-CANDIDATE (0x0025)
        if (useCandidate) {
            const attr = Buffer.alloc(4);
            attr.writeUInt16BE(0x0025, 0);
            attr.writeUInt16BE(0, 2);
            attrs.push(attr);
        }

        let packetSoFar: Buffer;

        // 5. MESSAGE-INTEGRITY (0x0008)
        if (token) {
            // Length for HMAC calc: Attrs + Integrity(24) ignoring Fingerprint
            // Calculate current attrs len
            const lenAttrs = attrs.reduce((a, b) => a + b.length, 0);
            const lenForHmac = lenAttrs + 24;

            // Write length to header for HMAC calculation
            header.writeUInt16BE(lenForHmac, 2);
            header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
            transactionId.copy(header, 8);

            const msgToSign = Buffer.concat([header, ...attrs]);
            const hmac = crypto.createHmac('sha1', token);
            hmac.update(msgToSign);
            const sig = hmac.digest();

            const attr = Buffer.alloc(24);
            attr.writeUInt16BE(0x0008, 0);
            attr.writeUInt16BE(20, 2);
            sig.copy(attr, 4);
            attrs.push(attr);
        }

        // 6. FINGERPRINT (0x8028)
        // Length for Fingerprint calc: Attrs (incl Integrity) + Fingerprint(8)
        {
            const lenAttrs = attrs.reduce((a, b) => a + b.length, 0);
            const lenFinal = lenAttrs + 8; // +8 for fingerprint

            // Update header with FINAL length
            header.writeUInt16BE(lenFinal, 2);
            // Header magic/tid already set

            const msgToCrc = Buffer.concat([header, ...attrs]);
            const crcVal = crc32(msgToCrc);
            const fingerprint = (crcVal ^ 0x5354554e) >>> 0;

            const attr = Buffer.alloc(8);
            attr.writeUInt16BE(0x8028, 0);
            attr.writeUInt16BE(4, 2);
            attr.writeUInt32BE(fingerprint, 4);
            attrs.push(attr);
        }

        const packet = Buffer.concat([header, ...attrs]);
        this.socket.send(packet, relay.port, relay.ip);
    }

    stop() { this.socket = null; }
}