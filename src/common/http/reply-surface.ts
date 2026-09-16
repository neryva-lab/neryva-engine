/**
 * Reply-surface adapter (Fastify migration hardening): depending on where Nest
 * hands us the response object we get either a FastifyReply (status/code +
 * header + send) or the raw Node ServerResponse (statusCode property +
 * setHeader + end) — global middie middleware and switchToHttp().getResponse()
 * in filters/interceptors see the raw shape, while @Res() injection sees the
 * framework shape. This adapter calls whichever surface exists so one code
 * path serves both without Express-isms.
 */
export interface ReplySurface {
  status(code: number): { send(body: unknown): void };
  setHeader(name: string, value: string): void;
}

interface RawShape {
  status?: (code: number) => { send: (body: unknown) => void };
  code?: (code: number) => { send: (body: unknown) => void };
  header?: (name: string, value: string) => void;
  setHeader?: (name: string, value: string) => void;
  statusCode?: number;
  headersSent?: boolean;
  writableEnded?: boolean;
  end?: (body: string) => void;
}

export function asReplySurface(response: unknown): ReplySurface {
  const res = response as RawShape;
  return {
    status(code: number) {
      if (typeof res.status === 'function') {
        return res.status(code);
      }
      if (typeof res.code === 'function') {
        return res.code(code);
      }
      if (typeof res.statusCode === 'number') {
        res.statusCode = code;
      }
      return {
        send(body: unknown): void {
          if (res.headersSent === true || res.writableEnded === true) {
            return;
          }
          const text = typeof body === 'string' ? body : JSON.stringify(body);
          if (typeof res.setHeader === 'function') {
            try {
              res.setHeader('content-type', 'application/json');
            } catch {
              // headers already sent — best effort only
            }
          }
          res.end?.(text);
        },
      };
    },
    setHeader(name: string, value: string): void {
      if (typeof res.header === 'function') {
        res.header(name, value);
      } else if (typeof res.setHeader === 'function') {
        res.setHeader(name, value);
      }
    },
  };
}
