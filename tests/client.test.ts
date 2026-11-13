import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpxClient } from '../src/client';
import { SpxError } from '../src/errors';

const session = { cookie: 'spx_token=abc; other=1', userAgent: 'UA/1.0' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('SpxClient.call', () => {
  it('sends the session cookie and returns `data` on retcode 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ retcode: 0, data: { account_id: 42 } }));
    vi.stubGlobal('fetch', fetchMock);
    const data = await new SpxClient(session).baseInfo();
    expect(data).toEqual({ account_id: 42 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://spx.vn/shipment/account/api/base_info/detail');
    expect(init.method).toBe('GET');
    expect(init.headers.cookie).toBe(session.cookie);
    expect(init.headers['user-agent']).toBe('UA/1.0');
  });

  it('builds the balance query with a string account id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ retcode: 0, data: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await new SpxClient(session).balance(123);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      business_entity: '4',
      product_line: '7',
      biz_account_id: '123',
    });
  });

  it('posts transactions with biz_account_id as a string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ retcode: 0, data: { list: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await new SpxClient(session).transactions({ bizAccountId: 7, types: [1] });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      business_entity: 4,
      product_line: 7,
      offset: 0,
      size: 50,
      seller_tran_type_list: [1],
      biz_account_id: '7',
    });
  });

  it('maps a login-related retcode to SESSION_EXPIRED and others to API_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ retcode: 10001, message: 'please login', data: null })));
    await expect(new SpxClient(session).baseInfo()).rejects.toMatchObject({ code: 'SESSION_EXPIRED', status: 10001 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ retcode: -1000012, message: 'param error', data: null })));
    await expect(new SpxClient(session).baseInfo()).rejects.toMatchObject({ code: 'API_ERROR', status: -1000012 });
  });

  it('maps HTTP 401/403, other statuses and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    await expect(new SpxClient(session).baseInfo()).rejects.toMatchObject({ code: 'SESSION_EXPIRED', status: 403 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })));
    await expect(new SpxClient(session).baseInfo()).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 502 });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(new SpxClient(session).baseInfo()).rejects.toBeInstanceOf(SpxError);
  });

  it('rejects a non-JSON body and a tiny label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
    await expect(new SpxClient(session).baseInfo()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 200 })));
    await expect(new SpxClient(session).label(['SN1'])).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
