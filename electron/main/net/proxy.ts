import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

type HeaderRecord = Record<string, string>;
type ProxyHeaders = Headers | Array<[string, string]> | HeaderRecord;
type ProxyBody = string | URLSearchParams | ArrayBuffer | ArrayBufferView | null | undefined;

interface ProxiedRequestInit {
  method?: string;
  headers?: ProxyHeaders;
  body?: ProxyBody;
}

export interface ProxyTestResult {
  ok: boolean;
  ip?: string;
  proxy?: string;
  error?: string;
}

export function normalizeProxyUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;

  const parts = value.split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    const [host, port, user, ...passwordParts] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(passwordParts.join(":"))}@${host}:${port}`;
  }

  return `http://${value}`;
}

export function steamUserProxyOptions(proxy: string | null | undefined): Record<string, unknown> {
  const normalized = normalizeProxyUrl(proxy);
  if (!normalized) return {};
  const protocol = new URL(normalized).protocol.toLowerCase();
  if (protocol.startsWith("socks")) {
    return { socksProxy: normalized, proxyTimeout: 10_000 };
  }
  return { httpProxy: normalized, proxyTimeout: 10_000 };
}

export function redactProxy(proxy: string | null | undefined): string | undefined {
  const normalized = normalizeProxyUrl(proxy);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return "<invalid proxy>";
  }
}

function headersToRecord(headers: ProxyHeaders | undefined): HeaderRecord {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return { ...headers };
}

function bodyToBuffer(body: ProxyBody): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("Unsupported proxied request body type.");
}

function createAgent(targetProtocol: string, proxyUrl: string): unknown {
  const proxyProtocol = new URL(proxyUrl).protocol.toLowerCase();
  if (proxyProtocol.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  if (targetProtocol === "https:") return new HttpsProxyAgent(proxyUrl);
  return new HttpProxyAgent(proxyUrl);
}

export async function fetchWithProxy(
  url: string,
  init: ProxiedRequestInit = {},
  proxy?: string | null,
): Promise<Response> {
  const normalized = normalizeProxyUrl(proxy);
  if (!normalized) return fetch(url, init as RequestInit);

  const target = new URL(url);
  const body = bodyToBuffer(init.body);
  const headers = headersToRecord(init.headers);
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(body.byteLength);
  }

  return new Promise<Response>((resolve, reject) => {
    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(
      target,
      {
        method: init.method ?? "GET",
        headers,
        agent: createAgent(target.protocol, normalized) as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
            else if (value !== undefined) responseHeaders.set(key, String(value));
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error("Proxy request timed out.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function testProxy(proxy: string): Promise<ProxyTestResult> {
  const normalized = normalizeProxyUrl(proxy);
  if (!normalized) return { ok: false, error: "Proxy is empty." };
  try {
    const res = await fetchWithProxy("https://api.ipify.org?format=json", { method: "GET" }, normalized);
    if (!res.ok) return { ok: false, proxy: redactProxy(normalized), error: `HTTP ${res.status}` };
    const json = (await res.json()) as { ip?: string };
    return { ok: Boolean(json.ip), ip: json.ip, proxy: redactProxy(normalized) };
  } catch (err) {
    return { ok: false, proxy: redactProxy(normalized), error: (err as Error).message };
  }
}
