
import { proto } from '@whiskeysockets/baileys/WAProto';
import * as fs from 'fs';

const data = fs.readFileSync('call_dump_decrypted.json', 'utf8');
const blocks = data.split('\n---\n');

for (const block of blocks) {
    try {
        const json = JSON.parse(block);
        if (json.type === 'Buffer') {
            const buf = Buffer.from(json.data);
            const msg = proto.Message.decode(buf);
            console.log(JSON.stringify(msg.toJSON(), null, 2));
        }
    } catch (e) {
        // console.error(e);
    }
}
