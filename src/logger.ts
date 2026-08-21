import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino, { type Level, type StreamEntry } from 'pino';

const level = (process.env.LOG_LEVEL || 'info') as Level;
const logDir = process.env.LOG_DIR;

function stdoutStream(): StreamEntry {
  if (process.env.NODE_ENV !== 'production') {
    return {
      level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: { colorize: true },
      }),
    };
  }
  return { level, stream: process.stdout };
}

function fileStream(dir: string): StreamEntry {
  mkdirSync(dir, { recursive: true });
  return {
    level,
    stream: pino.transport({
      target: 'pino-roll',
      options: {
        file: path.join(dir, 'app.log'),
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        extension: '.log',
        mkdir: true,
      },
    }),
  };
}

export const logger = logDir
  ? pino({ level }, pino.multistream([stdoutStream(), fileStream(logDir)]))
  : pino({
      level,
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    });