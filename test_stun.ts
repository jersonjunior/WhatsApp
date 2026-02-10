import { StunClient } from './src/media/stun-client';
import * as dgram from 'dgram';

console.log('--- Starting STUN Connectivity Test ---');

const socket = dgram.createSocket('udp4');
const stun = new StunClient();

stun.on('binding-success', (rinfo) => {
    console.log(`✅ STUN SUCCESS! Public IP: ${rinfo.address}:${rinfo.port}`);
    console.log('Your network allows UDP STUN traffic.');
    process.exit(0);
});

socket.on('message', (msg, rinfo) => {
    console.log(`[RX] Packet received from ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);
    stun.handleMessage(msg, rinfo);
});

socket.bind(0, () => {
    const addr = socket.address() as any;
    console.log(`Socket bound to local port ${addr.port}`);
    stun.start(socket);

    // Test Google STUN (Standard)
    const target = { ip: 'stun.l.google.com', port: 19302 };
    console.log(`Sending STUN Binding Request to ${target.ip}:${target.port}...`);

    // Send without username/token (Classic STUN)
    stun.sendBindingRequest(target);

    // Keep sending every second
    setInterval(() => {
        console.log('Retrying STUN request...');
        stun.sendBindingRequest(target);
    }, 1000);
});

// Timeout after 10 seconds
setTimeout(() => {
    console.error('❌ STUN Test Timed Out. No response received.');
    console.error('This indicates a Firewall or Router block for UDP traffic.');
    process.exit(1);
}, 10000);
