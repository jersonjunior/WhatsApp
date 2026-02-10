const sip = require('sip');
import { log } from '../utils/logger';
import { config } from '../config';
import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';

function md5(content: string): string {
    return createHash('md5').update(content).digest('hex');
}

export class SIPClient extends EventEmitter {
    private registered: boolean = false;
    private localPort: number = 5060;
    private transport: any;
    private activeDialogs: Map<string, any> = new Map();
    private cseq: number = 1;

    constructor() {
        super();
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // Initialize SIP stack
                // Binding specifically to the public IP to ensure correct interface selection
                this.transport = sip.create({
                    address: config.network.publicIp,
                    port: this.localPort,
                    publicAddress: config.network.publicIp,
                    logger: {
                        send: (message: any, target: any) => {
                            log.info('[SIP OUTGOING]', {
                                target: `${target.address}:${target.port}`,
                                method: message.method,
                                callId: message.headers['call-id']
                            });
                        },
                        recv: (message: any, remote: any) => {
                            log.info('[SIP INCOMING]', {
                                source: `${remote.address}:${remote.port}`,
                                method: message.method,
                                status: message.status,
                                callId: message.headers['call-id']
                            });
                        },
                        error: (e: any) => {
                            log.error('[SIP INTERNAL ERROR]', e);
                        }
                    }
                }, (request: any) => {
                    this.handleRequest(request);
                });

                log.info(`[SIP] UDP Transport started on ${config.network.publicIp}:${this.localPort}`);

                // Attempt Registration
                this.register()
                    .then(() => {
                        log.info('[SIP] Registered successfully');
                        this.registered = true;
                        this.emit('registered');
                        resolve();
                    })
                    .catch((err) => {
                        log.error('[SIP] Registration failed', {
                            message: err.message,
                            stack: err.stack,
                            code: err.code
                        });
                        resolve(); // Resolve anyway to keep app alive
                    });

            } catch (error: any) {
                log.error('[SIP] Failed to start UDP transport', {
                    message: error.message,
                    stack: error.stack
                });
                reject(error);
            }
        });
    }

    private async register(): Promise<void> {
        return new Promise((resolve, reject) => {
            const registerMessage: any = {
                method: 'REGISTER',
                uri: `sip:${config.asterisk.host}`,
                headers: {
                    to: { uri: `sip:${config.asterisk.user}@${config.asterisk.host}` },
                    from: { uri: `sip:${config.asterisk.user}@${config.asterisk.host}`, params: { tag: randomUUID() } },
                    'call-id': randomUUID(),
                    cseq: { method: 'REGISTER', seq: this.cseq++ },
                    contact: [{ uri: `sip:${config.asterisk.user}@${config.network.publicIp}:${this.localPort}` }],
                    'max-forwards': 70,
                    'user-agent': 'NodeJS SIP Gateway',
                    expires: 3600
                }
            };

            this.transport.send(registerMessage, (response: any) => {
                if (response.status >= 200 && response.status < 300) {
                    resolve();
                } else if (response.status === 401 && response.headers && response.headers['www-authenticate']) {
                    // Handle Digest Auth
                    let authHeader = response.headers['www-authenticate'];

                    // sip.js parses headers as objects or arrays of objects
                    if (Array.isArray(authHeader)) {
                        authHeader = authHeader[0];
                    }

                    // Access properties directly from the object parsed by sip.js
                    // Remove quotes if present, although sip.js usually keeps them in value
                    const realm = authHeader.realm ? authHeader.realm.replace(/"/g, '') : null;
                    const nonce = authHeader.nonce ? authHeader.nonce.replace(/"/g, '') : null;

                    if (!realm || !nonce) {
                        reject(new Error('Invalid WWW-Authenticate header: missing realm or nonce'));
                        return;
                    }

                    // Calculate response
                    const ha1 = md5(`${config.asterisk.user}:${realm}:${config.asterisk.password}`);
                    const ha2 = md5(`REGISTER:sip:${config.asterisk.host}`);
                    const responseDigest = md5(`${ha1}:${nonce}:${ha2}`);

                    // Resend Register with Auth
                    registerMessage.headers.cseq.seq = this.cseq++;

                    // Construct Authorization header manually as a string to ensure correct formatting
                    // PJSIP seems to dislike the object stringification from sip.js, so we do it manually.
                    registerMessage.headers.authorization = `Digest username="${config.asterisk.user}", realm="${realm}", nonce="${nonce}", uri="sip:${config.asterisk.host}", response="${responseDigest}", algorithm="MD5"`;

                    this.transport.send(registerMessage, (res2: any) => {
                        if (res2.status >= 200 && res2.status < 300) {
                            resolve();
                        } else {
                            reject(new Error(`Registration failed with status ${res2.status}`));
                        }
                    });

                } else {
                    reject(new Error(`Registration failed with status ${response.status}`));
                }
            });
        });
    }

    private handleRequest(request: any) {
        log.info('[SIP] Received UDP Request', { method: request.method, headers: request.headers });

        if (request.method === 'OPTIONS') {
            this.transport.send(sip.makeResponse(request, 200, 'OK'));
        }
        else if (request.method === 'BYE') {
            const callId = request.headers['call-id'];
            if (this.activeDialogs.has(callId)) {
                this.activeDialogs.delete(callId);
                this.emit('call:terminated', callId);
            }
            this.transport.send(sip.makeResponse(request, 200, 'OK'));
        }
    }

    async makeCall(destination: string, sessionId: string, options?: { localRtpPort?: number }): Promise<any> {
        return new Promise((resolve, reject) => {
            // Determine local RTP port for SDP
            const textPort = options?.localRtpPort || config.rtp.portMin;

            const invite: any = {
                method: 'INVITE',
                uri: `sip:${destination}@${config.asterisk.host}`,
                headers: {
                    to: { uri: `sip:${destination}@${config.asterisk.host}` },
                    from: { uri: `sip:${config.asterisk.user}@${config.asterisk.host}`, params: { tag: randomUUID() } },
                    'call-id': sessionId,
                    cseq: { method: 'INVITE', seq: this.cseq++ },
                    contact: [{ uri: `sip:${config.asterisk.user}@${config.network.publicIp}:${this.localPort}` }],
                    'content-type': 'application/sdp',
                    subject: 'WhatsApp Call',
                    'max-forwards': 70,
                    'user-agent': 'NodeJS SIP Gateway'
                },
                content:
                    'v=0\r\n' +
                    'o=- ' + Date.now() + ' ' + Date.now() + ' IN IP4 ' + config.network.publicIp + '\r\n' +
                    's=WhatsApp Call\r\n' +
                    'c=IN IP4 ' + config.network.publicIp + '\r\n' +
                    't=0 0\r\n' +
                    'm=audio ' + textPort + ' RTP/AVP 0 8 111 101\r\n' +
                    'a=rtpmap:111 opus/48000/2\r\n' +
                    'a=fmtp:111 minptime=10;useinbandfec=1\r\n' +
                    'a=rtpmap:0 PCMU/8000\r\n' +
                    'a=rtpmap:8 PCMA/8000\r\n' +
                    'a=rtpmap:101 telephone-event/8000\r\n' +
                    'a=fmtp:101 0-16\r\n' +
                    'a=ptime:20\r\n' +
                    'a=sendrecv'
            };

            const handleResponse = (response: any) => {
                log.info('[SIP] Received response for INVITE', { status: response.status, callId: sessionId });

                if (response.status >= 200 && response.status < 300) {
                    // Call established
                    const dialog = {
                        uri: response.headers.contact ? response.headers.contact[0].uri : invite.uri,
                        headers: {
                            to: response.headers.to,
                            from: response.headers.from,
                            'call-id': response.headers['call-id'],
                            cseq: { method: 'BYE', seq: invite.headers.cseq.seq + 1 },
                            route: response.headers.record_route
                        }
                    };
                    this.activeDialogs.set(sessionId, dialog);

                    // Parse SDP
                    let remoteRtpIp = config.asterisk.host;
                    let remoteRtpPort = 10000;

                    if (response.content) {
                        const sdp = response.content;
                        const cLine = sdp.match(/c=IN IP4 ([\d\.]+)/);
                        const mLine = sdp.match(/m=audio (\d+) RTP\/AVP/);

                        if (cLine && cLine[1]) remoteRtpIp = cLine[1];
                        if (mLine && mLine[1]) remoteRtpPort = parseInt(mLine[1], 10);

                        // Check codec
                        const opusMap = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
                        log.info('[SIP] Extracted Remote RTP details', {
                            remoteRtpIp,
                            remoteRtpPort,
                            isOpusNegotiated: sdp.includes('opus')
                        });

                        if (!sdp.toLowerCase().includes('opus')) {
                            log.error('[SIP] ❌ WARNING: Asterisk did NOT negotiate Opus! Audio will likely fail.');
                        }
                    }

                    this.emit('call:established', sessionId, { remoteRtpIp, remoteRtpPort });

                    // Send ACK
                    this.transport.send({
                        method: 'ACK',
                        uri: dialog.uri,
                        headers: {
                            to: response.headers.to,
                            from: response.headers.from,
                            'call-id': response.headers['call-id'],
                            cseq: { method: 'ACK', seq: invite.headers.cseq.seq },
                            via: response.headers.via,
                            route: dialog.headers.route, // Use dialog.headers.route for ACK
                            'max-forwards': 70
                        }
                    });
                    resolve({ response, remoteRtpIp, remoteRtpPort });
                } else if (response.status === 401 || response.status === 407) {
                    // Auth required - we entered here recursively
                    log.error('[SIP] Unexpected 401/407 inside handleResponse (loop?)');
                } else if (response.status >= 300) {
                    log.warn(`[SIP] Call failed with status ${response.status}`);
                    reject(new Error(`SIP Error: ${response.status}`));
                }
            };

            // Send initial INVITE
            this.transport.send(invite, (response: any) => {
                if (response.status === 401 || response.status === 407) {
                    log.info('[SIP] INVITE requires authentication, attempting Digest Auth...');

                    let authHeader = response.headers['www-authenticate'] || response.headers['proxy-authenticate'];
                    if (Array.isArray(authHeader)) authHeader = authHeader[0];

                    // Simple digest calculation
                    const realm = authHeader.realm?.replace(/"/g, '');
                    const nonce = authHeader.nonce?.replace(/"/g, '');
                    const algorithm = authHeader.algorithm || 'MD5';

                    if (!realm || !nonce) {
                        log.error('[SIP] Missing realm/nonce in auth challenge');
                        reject(new Error('Auth failed'));
                        return;
                    }

                    const uri = `sip:${destination}@${config.asterisk.host}`;
                    const ha1 = md5(`${config.asterisk.user}:${realm}:${config.asterisk.password}`);
                    const ha2 = md5(`INVITE:${uri}`);
                    const responseDigest = md5(`${ha1}:${nonce}:${ha2}`);

                    // Update CSeq and add Auth header
                    invite.headers.cseq.seq++;
                    invite.headers.authorization = `Digest username="${config.asterisk.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseDigest}", algorithm="${algorithm}"`;

                    log.info('[SIP] Sending Authenticated INVITE');
                    this.transport.send(invite, handleResponse);
                } else {
                    handleResponse(response);
                }
            });
        });
    }

    async disconnect(): Promise<void> {
        if (this.transport) {
            this.registered = false;
        }
    }

    isConnected(): boolean {
        return this.registered;
    }

    async hangup(sessionId: string): Promise<void> {
        const dialog = this.activeDialogs.get(sessionId);
        if (!dialog) {
            log.warn('[SIP] No active dialog found for', sessionId);
            return;
        }

        log.info('[SIP] Sending BYE', { sessionId });

        this.transport.send({
            method: 'BYE',
            uri: dialog.uri,
            headers: {
                to: dialog.headers.to,
                from: dialog.headers.from,
                'call-id': dialog.headers['call-id'],
                cseq: { method: 'BYE', seq: dialog.headers.cseq.seq++ },
                route: dialog.headers.route
            }
        }, (res: any) => {
            log.info('[SIP] BYE response', { status: res?.status });
        });

        this.activeDialogs.delete(sessionId);
    }
}
