
import { proto } from '@whiskeysockets/baileys/WAProto';
import * as fs from 'fs';

const dumpFile = 'call_dump_decrypted.json';

function decode() {
    console.log('Reading dump file...');
    const content = fs.readFileSync(dumpFile, 'utf-8');
    const sections = content.split('\n---\n');

    // Get the last section that has data
    let lastSection = null;
    for (let i = sections.length - 1; i >= 0; i--) {
        if (sections[i].trim().length > 0 && sections[i].includes('"type": "Buffer"')) {
            lastSection = sections[i];
            break;
        }
    }

    if (!lastSection) {
        console.error('No buffer section found in dump');
        return;
    }

    try {
        const json = JSON.parse(lastSection);
        if (json.type === 'Buffer' && Array.isArray(json.data)) {
            const buffer = Buffer.from(json.data);
            console.log(`Buffer found, size: ${buffer.length}`);

            // Try decoding as Message first
            try {
                const msg = proto.Message.decode(buffer);
                console.log('Decoded as proto.Message:');
                console.log(JSON.stringify(msg.toJSON(), null, 2));
            } catch (e: any) {
                console.log('Failed to decode as proto.Message', e.message);
            }

            // Inspect keys of proto to find Call or similar
            // console.log('Available proto keys:', Object.keys(proto));

        } else {
            console.error('Invalid JSON structure');
        }
    } catch (e: any) {
        console.error('Failed to parse JSON', e);
    }
}

decode();
