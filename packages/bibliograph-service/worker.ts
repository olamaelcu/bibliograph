import { runTapConsumer } from './src/lib/server/tap-consumer';
import { createLogger } from './src/lib/server/logger';

const log = createLogger('worker');
log.info('worker process started');

runTapConsumer(log).catch((err) => {
  log.fatal({ err }, 'tap consumer crashed');
  process.exit(1);
});
