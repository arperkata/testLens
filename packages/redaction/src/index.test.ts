import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, mask, newStats, redactBodyString, redactHeaders, redactText, redactUrl } from './index';

describe('redaction', () => {
  it('masks sensitive headers and keeps others', () => {
    const stats = newStats();
    const out = redactHeaders(
      [
        { name: 'Authorization', value: 'Bearer abc.def.ghi' },
        { name: 'Cookie', value: 'sid=123' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Api-Key', value: 'k-1' },
      ],
      DEFAULT_RULES,
      stats,
    );
    expect(out[0]!.value).toMatch(/^«redacted:[0-9a-f]{8}»$/);
    expect(out[1]!.value).toMatch(/^«redacted:/);
    expect(out[2]!.value).toBe('application/json');
    expect(out[3]!.value).toMatch(/^«redacted:/);
    expect(stats.counts['header.authorization']).toBe(1);
  });

  it('keeps equal secrets correlatable', () => {
    expect(mask('same')).toBe(mask('same'));
    expect(mask('same')).not.toBe(mask('other'));
  });

  it('redacts query params and userinfo in URLs', () => {
    const stats = newStats();
    const out = redactUrl('https://user:pw@api.example.com/v1/x?token=abc&page=2', DEFAULT_RULES, stats);
    expect(out).not.toContain('abc');
    expect(out).toContain('page=2');
    expect(out).not.toContain('pw@');
  });

  it('redacts JSON bodies by key and detects JWTs in text', () => {
    const stats = newStats();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const body = JSON.stringify({ user: { password: 'hunter2', name: 'Ann' }, access_token: 'tok', note: `my token is ${jwt}` });
    const out = JSON.parse(redactBodyString(body, 'application/json', DEFAULT_RULES, stats)) as Record<string, unknown>;
    expect((out.user as Record<string, string>).password).toMatch(/^«redacted:/);
    expect((out.user as Record<string, string>).name).toBe('Ann');
    expect(out.access_token).toMatch(/^«redacted:/);
    expect(out.note as string).not.toContain(jwt);
    expect(stats.counts['json.password']).toBe(1);
  });

  it('redacts bearer tokens and AWS keys in free text', () => {
    const stats = newStats();
    const out = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 key AKIAIOSFODNN7EXAMPLE', DEFAULT_RULES, stats);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts form-encoded bodies', () => {
    const stats = newStats();
    const out = redactBodyString('username=ann&password=secret1&remember=1', 'application/x-www-form-urlencoded', DEFAULT_RULES, stats);
    expect(out).toContain('username=ann');
    expect(out).not.toContain('secret1');
  });
});
