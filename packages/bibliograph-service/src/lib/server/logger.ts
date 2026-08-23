import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';

const LOG_DIR = process.env.LOG_DIR ?? 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const PRETTY_STDOUT = process.env.NODE_ENV !== 'production';

export type ProcessName = 'web' | 'worker';

export function createLogger(name: ProcessName) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const filePath = path.join(LOG_DIR, `${name}.${process.pid}.log`);

  const targets: pino.TransportTargetOptions[] = [
    { target: 'pino/file', options: { destination: filePath, mkdir: false } },
    PRETTY_STDOUT
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
      : { target: 'pino/file', options: { destination: 1 } },
  ];

  return pino(
    {
      level: LOG_LEVEL,
      base: { service: name, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.transport({ targets }),
  );
}
