import http from 'node:http';

export interface LanFaultRules {
  /** Randomly drop requests with this probability (0-1); 0 disables. */
  dropRate?: number;
  /** Extra latency per request in ms; 0 disables. */
  delayMs?: number;
}

/**
 * Loopback HTTP fault-injection proxy for L0: forwards worker traffic to the
 * real center while randomly dropping or delaying requests per the rules.
 * Drops reset the socket, so a request may or may not have already reached
 * the center — exactly the ambiguity workers must survive. Workers must
 * recover through their existing retry/idempotency/timeout behavior; that
 * is what the tests assert.
 */
export class LanFaultProxy {
  private readonly server: http.Server;
  private counter = 0;
  private dropped = 0;
  private port = 0;

  private constructor(
    private readonly target: URL,
    private readonly rules: LanFaultRules,
  ) {
    this.server = http.createServer((req, res) => {
      this.counter += 1;
      if (this.rules.dropRate && Math.random() < this.rules.dropRate) {
        this.dropped += 1;
        res.socket?.destroy();
        return;
      }
      const forward = (): void => {
        const upstream = http.request(
          {
            protocol: this.target.protocol,
            hostname: this.target.hostname,
            port: this.target.port,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: this.target.host },
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(upstream);
      };
      if (this.rules.delayMs) {
        setTimeout(forward, this.rules.delayMs);
      } else {
        forward();
      }
    });
  }

  static async start(options: {
    targetUrl: string;
    rules: LanFaultRules;
    port?: number;
  }): Promise<LanFaultProxy> {
    const target = new URL(options.targetUrl);
    const proxy = new LanFaultProxy(target, options.rules);
    const port = options.port ?? 0;
    await new Promise<void>((resolve) => proxy.server.listen(port, '127.0.0.1', resolve));
    const address = proxy.server.address();
    if (!address || typeof address === 'string') throw new Error('fault proxy failed to listen');
    proxy.port = address.port;
    return proxy;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get requestCount(): number {
    return this.counter;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
