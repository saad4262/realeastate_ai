import { monitoring } from './lib/browser-monitoring';

/** Error monitoring in the browser (ADR 0082): errors only, no session replay, loaded late. */
monitoring.start();
