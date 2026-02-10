/**
 * SRTP Key Extractor - Versão Corrigida para WhatsApp WASP Protocol
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

const log = {
    info: (msg: string, args?: any) => {
        console.log(`[KeyExtractor] ${msg}`, args || '');
        try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', `\n[KeyExtractor] ${msg} ${JSON.stringify(args || '')}\n`); } catch (e) { }
    },
    warn: (msg: string, args?: any) => {
        console.warn(`[KeyExtractor] ${msg}`, args || '');
        try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', `\n[KeyExtractor] WARN: ${msg} ${JSON.stringify(args || '')}\n`); } catch (e) { }
    },
    error: (msg: string, args?: any) => {
        console.error(`[KeyExtractor] ${msg}`, args || '');
        try { fs.appendFileSync('c:/Users/Jr/Desktop/WhatsApp/token_debug.txt', `\n[KeyExtractor] ERROR: ${msg} ${JSON.stringify(args || '')}\n`); } catch (e) { }
    }
};

export interface ExtractedKeys {
    masterKey: Buffer;
    masterSalt: Buffer;
    relayEndpoints: { ip: string; port: number; token?: Buffer }[];
}

/**
 * Extrai chaves SRTP de um JSON protobuf descriptografado (Baileys/WAP)
 */
export function extractKeysFromDecryptedProto(decryptedJson: any): { masterKey: Buffer, masterSalt: Buffer } | null {
    try {
        const callKeyData = decryptedJson?.call?.callKey;

        if (!callKeyData) {
            return null;
        }

        let callKey: Buffer;
        if (typeof callKeyData === 'string') {
            callKey = Buffer.from(callKeyData, 'base64');
        } else if (callKeyData.type === 'Buffer' && Array.isArray(callKeyData.data)) {
            callKey = Buffer.from(callKeyData.data);
        } else if (Buffer.isBuffer(callKeyData) || callKeyData instanceof Uint8Array) {
            callKey = Buffer.from(callKeyData);
        } else {
            return null;
        }

        // WhatsApp envia 30 ou 32 bytes (16 Key + 14/16 Salt)
        if (callKey.length >= 30) {
            const masterKey = callKey.slice(0, 16);
            // Werift e SRTP RFC exigem exatamente 14 bytes para o Salt no perfil AES128_HMAC80
            const masterSalt = callKey.slice(16, 30);

            log.info('[KeyExtractor] ✅ Chaves extraídas do nó callKey', {
                length: callKey.length,
                key: masterKey.toString('hex').substring(0, 8) + '...'
            });
            return { masterKey, masterSalt };
        }
        return null;
    } catch (error) {
        log.error('[KeyExtractor] Erro ao extrair do proto JSON', { error });
        return null;
    }
}

/**
 * Função principal de extração com suporte a múltiplos formatos de oferta
 */
export function extractSrtpKeys(offer: any): ExtractedKeys | null {
    try {
        let audioKeys: Buffer | null = null;
        const relayEndpoints: any[] = [];
        const tokens = new Map<string, Buffer>();

        // 1. Try to extract keys from Baileys object structure (Optimized extraction)
        if (offer && offer.call) {
            log.info('[KeyExtractor] offer.call properties:', Object.keys(offer.call));
            const protoKeys = extractKeysFromDecryptedProto(offer);

            if (Array.isArray(offer.call.relays)) {
                log.info('[KeyExtractor] Found relays array in Proto Object', { count: offer.call.relays.length });
                for (const r of offer.call.relays) {
                    const ip = r.ip ? (Array.isArray(r.ip) ? r.ip.join('.') : r.ip) : undefined;
                    const port = r.port;

                    if (ip && port) {
                        let token: Buffer | undefined;
                        if (r.token) {
                            if (Buffer.isBuffer(r.token)) token = r.token;
                            else if (Array.isArray(r.token)) token = Buffer.from(r.token);
                            else if (typeof r.token === 'string') token = Buffer.from(r.token, 'base64');
                            else if (r.token?.type === 'Buffer' && Array.isArray(r.token.data)) token = Buffer.from(r.token.data);
                        }
                        if (!token) log.warn('[KeyExtractor] Relay from Proto has NO token', { keys: Object.keys(r) });
                        else log.info('[KeyExtractor] Relay extracted from Proto with Token', { len: token.length });

                        relayEndpoints.push({ ip: String(ip), port: Number(port), token });
                    }
                }
            }

            if (protoKeys && protoKeys.masterKey && protoKeys.masterSalt) {
                // Reconstruct buffer for consistency if needed, but we essentially have the keys.
                // We will verify strictly at the end.
                log.info('[KeyExtractor] Keys extracted via Baileys Proto helper (Case 1)');
                // We don't stop here anymore! We continue to find Relays/Tokens in the structure.
                // If we had a way to convert protoKeys back to audioKeys buffer we would, 
                // but we can just return these keys + relays at the end.
                // Let's rely on the traverse finding the keys in 'call-key' usually, 
                // but if it fails, we fall back to these protoKeys.

                // Actually, let's store them to return if traversal doesn't find keys.
                // For now, let's proceed to finding Relays.
            }
        }

        // 2. Recursive Search (Pass 1 & Pass 2)
        // Detect root node to traverse
        const rootNode = (offer && offer.call) ? offer.call : offer;

        // Pass 1: Collect all tokens first
        const collectTokens = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (node.tag === 'token' && node.attrs?.id) {
                const b = node.content?.data ? Buffer.from(node.content.data) : Buffer.from(node.content || []);
                if (b.length > 0) {
                    tokens.set(node.attrs.id, b);
                    log.info('[KeyExtractor] Token found (Pass 1)', { id: node.attrs.id, len: b.length });
                }
            }
            if (Array.isArray(node.content)) node.content.forEach(collectTokens);
            else if (node.content && node.content.tag) collectTokens(node.content);
        };
        collectTokens(rootNode);

        // Pass 2: Process Relays and Keys
        const traverse = (node: any) => {
            if (!node || typeof node !== 'object') return;

            // Extract Relays (te / relay)
            if (node.tag === 'te' || node.tag === 'relay') {
                const endpoint = parseRelayEndpoint(node);
                if (endpoint) {
                    if (!endpoint.token && node.attrs?.token_id) {
                        endpoint.token = tokens.get(node.attrs.token_id);
                        if (!endpoint.token) log.warn('[KeyExtractor] Relay Token ID not found in map (Pass 2)', { tokenId: node.attrs.token_id });
                        else log.info('[KeyExtractor] Relay Token resolved via ID', { tokenId: node.attrs.token_id });
                    }
                    relayEndpoints.push(endpoint);
                    // log.info('[KeyExtractor] Relay extracted', { ip: endpoint.ip, port: endpoint.port, hasToken: !!endpoint.token });
                }
            }

            // Extract Keys (hbh_key / enc / call-key)
            // Prioritize call-key as it's standard in these traces
            if ((node.tag === 'hbh_key' || node.tag === 'enc' || node.tag === 'call-key') && node.content) {
                const b = node.content?.data ? Buffer.from(node.content.data) : Buffer.from(node.content || []);
                if (b.length >= 30) {
                    audioKeys = b;
                    log.info(`[KeyExtractor] Audio Keys found in tag '${node.tag}'`);
                }
            }

            if (Array.isArray(node.content)) node.content.forEach(traverse);
            else if (node.content && node.content.tag) traverse(node.content);
        };

        traverse(rootNode);

        // Logic to finalize keys
        let masterKey: Buffer | undefined;
        let masterSalt: Buffer | undefined;

        if (audioKeys) {
            let keysBuffer: Buffer = audioKeys;
            if (keysBuffer.length === 40) keysBuffer = Buffer.from(keysBuffer.toString(), 'base64');
            if (keysBuffer.length >= 30) {
                masterKey = keysBuffer.slice(0, 16);
                masterSalt = keysBuffer.slice(16, 30);
            }
        }

        // Fallback to Baileys Helper keys if traversal failed but Helper succeeded
        if (!masterKey && offer && offer.call) {
            const protoKeys = extractKeysFromDecryptedProto(offer);
            if (protoKeys) {
                masterKey = protoKeys.masterKey;
                masterSalt = protoKeys.masterSalt;
            }
        }

        // Fallback Strategy: If relays found but NO tokens linked, and we have orphan tokens
        if (relayEndpoints.length > 0 && tokens.size > 0) {
            const hasToken = relayEndpoints.some(r => r.token);
            if (!hasToken) {
                const fallbackToken = tokens.values().next().value;
                if (fallbackToken) {
                    log.warn('[KeyExtractor] ⚠️ Relays found without explicit tokens. Applying first available token as fallback.', { tokenLen: fallbackToken.length });
                    relayEndpoints.forEach(r => r.token = fallbackToken);
                }
            }
        }

        if (masterKey && masterSalt) {
            return {
                masterKey,
                masterSalt,
                relayEndpoints
            };
        }

        return null;
    } catch (error) {
        log.error('[KeyExtractor] Erro fatal na extração', { error });
        return null;
    }
}

export function parseRelayEndpoint(item: any): { ip: string; port: number; token?: Buffer } | null {
    try {
        let content = item.content?.data ? Buffer.from(item.content.data) : item.content;
        if (!Buffer.isBuffer(content)) return null;

        if (content.length >= 6) {
            const ip = `${content[0]}.${content[1]}.${content[2]}.${content[3]}`;
            const port = content.readUInt16BE(4);
            const token = content.length > 6 ? content.slice(6) : undefined;
            return { ip, port, token };
        }
        return null;
    } catch { return null; }
}

export function extractRelaysFromTransport(node: any): { relays: { ip: string; port: number, token?: Buffer }[], globalToken?: Buffer } {
    const relays: any[] = [];
    let globalToken: Buffer | undefined;

    const traverse = (n: any) => {
        if (!n || typeof n !== 'object') return;

        // Check for global token in transport message
        if (n.tag === 'token') {
            const b = n.content?.data ? Buffer.from(n.content.data) : Buffer.from(n.content || []);
            if (b.length > 0) {
                globalToken = b;
                log.info('[KeyExtractor] Global Token found in Transport message', { len: b.length });
            }
        }

        if (n.tag === 'te' || n.tag === 'cand' || n.tag === 'relay') {
            const ep = parseRelayEndpoint(n);
            if (ep) relays.push(ep);
        }
        if (Array.isArray(n.content)) n.content.forEach(traverse);
    };
    traverse(node);

    // Apply global token if found and relay lacks token (Local application)
    if (globalToken) {
        relays.forEach(r => {
            if (!r.token) {
                r.token = globalToken;
            }
        });
    }

    return { relays, globalToken };
}

export function extractRteFromOffer(offer: any): { ip: string; port: number } | null {
    try {
        if (offer && offer.call && Array.isArray(offer.call.relays)) {
            // Try to find a valid relay from proto
            const r = offer.call.relays[0]; // pick first
            if (r && r.ip && r.port) {
                const ip = Array.isArray(r.ip) ? r.ip.join('.') : r.ip;
                return { ip, port: r.port };
            }
        }
    } catch { }
    return null;
}