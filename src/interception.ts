import { Type } from 'typebox';

export const interceptRulesSchema = Type.Array(Type.Object({
  match: Type.Object({
    urlPattern: Type.String({ minLength: 1, maxLength: 2048, description: 'Absolute HTTP(S) URL glob; all conditions are ANDed.' }),
    urlContains: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    method: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    resourceType: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  }, { additionalProperties: false }),
  edit: Type.Object({
    url: Type.Optional(Type.String({ maxLength: 8192, description: 'Absolute same-origin HTTP(S) URL only; cross-origin edits skipped.' })),
    method: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 8192 }), Type.Null()]), { description: 'Merge case-insensitively; null deletes. Host, Content-Length, Connection, Transfer-Encoding forbidden.' })),
    postData: Type.Optional(Type.String({ maxLength: 65536, description: 'Replace UTF-8 body, including empty string; no automatic JSON merging.' })),
  }, { additionalProperties: false }),
  maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Default 1; first matching unexhausted rule wins.' })),
}, { additionalProperties: false }), { minItems: 1, maxItems: 16, description: 'intercept_start only. Rules affect future requests until exhausted/stopped, no replay. Max 256 KiB combined. Request values never journaled.' });

export type InterceptRule = {
  match: { urlPattern: string; urlContains?: string; method?: string; resourceType?: string };
  edit: { url?: string; method?: string; headers?: Record<string, string | null>; postData?: string };
  maxMatches?: number;
};
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\r\n\0]/.test(v);
function httpUrl(value: unknown) {
  if (!text(value, 8192)) return false;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
  catch { return false; }
}
/** Runtime boundary, including callers that bypass the tool's JSON schema. Never echo rule values in errors. */
export function validateRules(value: unknown): asserts value is InterceptRule[] {
  const fail = () => { throw new Error('Invalid interception rules. Use 1..16 bounded HTTP(S) URL rules with valid request edits.'); };
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || Buffer.byteLength(JSON.stringify(value), 'utf8') > 262144) fail();
  for (const r of value as any[]) {
    if (!object(r) || !keys(r, ['match', 'edit', 'maxMatches']) || !object(r.match) || !object(r.edit)) fail();
    const { match: m, edit: e } = r;
    if (!keys(m, ['urlPattern', 'urlContains', 'method', 'resourceType']) || !text(m.urlPattern) || !/^https?:\/\/[^/]+\//.test(m.urlPattern)) fail();
    if (['urlContains', 'resourceType'].some(k => m[k] !== undefined && !text(m[k]))) fail();
    if (m.method !== undefined && (!text(m.method, 32) || !token.test(m.method))) fail();
    if (r.maxMatches !== undefined && (!Number.isInteger(r.maxMatches) || r.maxMatches < 1 || r.maxMatches > 100)) fail();
    if (!keys(e, ['url', 'method', 'headers', 'postData']) || !Object.keys(e).length) fail();
    if (e.url !== undefined && !httpUrl(e.url)) fail();
    if (e.method !== undefined && (!text(e.method, 32) || !token.test(e.method))) fail();
    if (e.postData !== undefined && (typeof e.postData !== 'string' || e.postData.length > 65536)) fail();
    if (e.headers !== undefined) {
      if (!object(e.headers) || !Object.keys(e.headers).length || Object.keys(e.headers).length > 32) fail();
      const seen = new Set<string>();
      for (const [name, v] of Object.entries(e.headers)) {
        const lower = name.toLowerCase();
        if (!token.test(name) || name.length > 128 || ['host', 'content-length', 'connection', 'transfer-encoding'].includes(lower) || seen.has(lower)
          || (v !== null && (typeof v !== 'string' || v.length > 8192 || /[\r\n\0]/.test(v)))) fail();
        seen.add(lower);
      }
    }
  }
}
