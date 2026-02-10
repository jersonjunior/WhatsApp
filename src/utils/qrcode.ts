import qrcode from 'qrcode-terminal';
import { log } from './logger';

export function displayQRCode(qr: string): void {
    log.info('Scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
}
