import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface Config {
    asterisk: {
        host: string;
        port: number;
        user: string;
        password: string;
        realm: string;
        context: string;
        transport: 'UDP' | 'TCP' | 'TLS';
    };
    rtp: {
        portMin: number;
        portMax: number;
    };
    whatsapp: {
        sessionDir: string;
    };
    logging: {
        level: string;
        file: string;
    };
    network: {
        bindAddress: string;
        publicIp: string;
    },
}

function getEnv(key: string, defaultValue?: string): string {
    const value = process.env[key];
    if (!value && !defaultValue) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value || defaultValue!;
}

function getEnvNumber(key: string, defaultValue?: number): number {
    const value = process.env[key];
    if (!value && defaultValue === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value ? parseInt(value, 10) : defaultValue!;
}

export const config: Config = {
    asterisk: {
        host: getEnv('ASTERISK_HOST'),
        port: getEnvNumber('ASTERISK_PORT', 5060),
        user: getEnv('ASTERISK_USER'),
        password: getEnv('ASTERISK_PASSWORD'),
        realm: getEnv('ASTERISK_REALM', 'asterisk.local'),
        context: getEnv('ASTERISK_CONTEXT', 'from-whatsapp'),
        transport: (getEnv('SIP_TRANSPORT', 'UDP') as 'UDP' | 'TCP' | 'TLS'),
    },
    rtp: {
        portMin: getEnvNumber('RTP_PORT_MIN', 10000),
        portMax: getEnvNumber('RTP_PORT_MAX', 20000),
    },
    whatsapp: {
        sessionDir: getEnv('WHATSAPP_SESSION_DIR', './auth_info'),
    },
    logging: {
        level: getEnv('LOG_LEVEL', 'info'),
        file: getEnv('LOG_FILE', './logs/gateway.log'),
    },
    network: {
        bindAddress: getEnv('BIND_ADDRESS', '0.0.0.0'),
        publicIp: getEnv('PUBLIC_IP', '127.0.0.1'),
    },
};

// Validate configuration
export function validateConfig(): void {
    const errors: string[] = [];

    if (!config.asterisk.host) {
        errors.push('ASTERISK_HOST is required');
    }

    if (!config.asterisk.user) {
        errors.push('ASTERISK_USER is required');
    }

    if (!config.asterisk.password) {
        errors.push('ASTERISK_PASSWORD is required');
    }

    if (config.rtp.portMin >= config.rtp.portMax) {
        errors.push('RTP_PORT_MIN must be less than RTP_PORT_MAX');
    }

    if (errors.length > 0) {
        throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
}
