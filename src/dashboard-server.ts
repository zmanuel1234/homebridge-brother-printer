/*
 * The plugin's own dashboard page (the dashboardPort setting): the printers'
 * latest readings at http://<homebridge>:<port>/, for a browser or a wall
 * tablet. Read-only: it shows what the plugin last read, and changes nothing.
 * No serial numbers, passwords or other settings are served: each printer's
 * name, address and readings.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import os from 'node:os';
import type { Logging } from 'homebridge';

/** One printer as the page shows it */
export interface DashboardPrinter {
  name: string;
  host: string;
  online: boolean;
  /** When the plugin last read it (ms); 0 when not yet */
  updated: number;
  result: Record<string, unknown> | null;
}

const FILES: Record<string, [string, string]> = {
  '/': ['dashboard.html', 'text/html; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
};

/** The page's files: next to this file in dist/ (and src/ for tests) */
export const PUBLIC_DIR = join(__dirname, 'homebridge-ui', 'public');

/**
 * The page answers only when asked for by an address, this machine's name, or a
 * .local name: a web page elsewhere can't read it through a domain of its own
 * pointed at this machine (DNS rebinding).
 */
export function allowedHost(header: string | undefined): boolean {
  if (!header) { return true; }
  const name = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const me = os.hostname().toLowerCase();
  return isIP(name) !== 0 || name === 'localhost' || name === me || name.endsWith('.local') || name === me.split('.')[0];
}

export function startDashboard(port: number, log: Logging, printers: () => DashboardPrinter[]): http.Server {
  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (!allowedHost(req.headers.host)) {
      res.writeHead(403, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Open the dashboard by the Homebridge machine\'s address or name.');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET' }).end();
      return;
    }
    if (path === '/api/printers') {
      let body: string;
      try {
        body = JSON.stringify(printers());
      } catch (err) {
        res.writeHead(500, headers).end(String((err as Error)?.message || err));
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }).end(body);
      return;
    }
    const file = FILES[path];
    if (!file) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    readFile(join(PUBLIC_DIR, file[0]))
      .then((data) => { res.writeHead(200, { ...headers, 'Content-Type': file[1] }).end(data); })
      .catch(() => { res.writeHead(500, headers).end(); });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    log.warn(err.code === 'EADDRINUSE'
      ? `Dashboard: port ${port} is already in use; choose another "Dashboard port" in the settings.`
      : `Dashboard: ${err.message}`);
  });
  server.listen(port, () => {
    log.info(`Printer dashboard at http://<this Homebridge's address>:${port}/`);
  });
  return server;
}
