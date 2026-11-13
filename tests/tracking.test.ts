import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTracking, parseTracking, trackingUrl } from '../src/tracking';

afterEach(() => vi.unstubAllGlobals());

const record = (code: string, time: number, extra: Record<string, unknown> = {}) => ({
  tracking_code: code,
  tracking_name: `name ${code}`,
  description: `desc ${code}`,
  actual_time: time,
  display_flag: 1,
  ...extra,
});

describe('trackingUrl', () => {
  it('builds the public tracking link', () => {
    expect(trackingUrl(' SPXVN0123 ')).toBe('https://spx.vn/track?SPXVN0123');
  });
});

describe('parseTracking', () => {
  it('reads status, records, pickup and delivery times', () => {
    const t = parseTracking('SPXVN1', {
      order_info: { tracking_code_group_name: 'Delivered' },
      sls_tracking_info: {
        records: [
          record('F980', 400, { current_location: { location_name: 'Hue' }, buyer_description: 'Delivered!' }),
          record('F510', 300, { display_flag: 0 }),
          record('f100', 200),
          record('F000', 100),
        ],
      },
    });
    expect(t.statusGroup).toBe('Delivered');
    expect(t.deliveredAt).toBe(400);
    expect(t.pickedUpAt).toBe(200);
    expect(t.records[0]).toEqual({
      code: 'F980',
      name: 'name F980',
      description: 'Delivered!',
      time: 400,
      visible: true,
      location: 'Hue',
    });
    expect(t.records[1].visible).toBe(false);
    expect(t.records[2].code).toBe('F100');
  });

  it('falls back to the earliest non-F000 scan when F100 is missing', () => {
    const t = parseTracking('SPXVN1', {
      sls_tracking_info: { records: [record('F510', 300), record('F440', 250), record('F000', 100)] },
    });
    expect(t.pickedUpAt).toBe(250);
    expect(t.deliveredAt).toBeNull();
    expect(t.statusGroup).toBeNull();
  });

  it('handles an empty payload', () => {
    expect(parseTracking('X', null)).toEqual({
      trackingNumber: 'X',
      statusGroup: null,
      records: [],
      pickedUpAt: null,
      deliveredAt: null,
    });
  });
});

describe('getTracking', () => {
  it('calls the public endpoint without cookies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ retcode: 0, data: { order_info: { tracking_code_group_name: 'In Transit' } } })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const t = await getTracking(' SPXVN9 ');
    expect(fetchMock.mock.calls[0][0]).toBe('https://spx.vn/shipment/order/open/order/get_order_info?spx_tn=SPXVN9');
    expect(fetchMock.mock.calls[0][1].headers.cookie).toBeUndefined();
    expect(t.trackingNumber).toBe('SPXVN9');
    expect(t.statusGroup).toBe('In Transit');
  });

  it('throws on HTTP errors, non-JSON bodies and error retcodes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    await expect(getTracking('A')).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 500 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>')));
    await expect(getTracking('A')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ retcode: 3, message: 'not found' }))),
    );
    await expect(getTracking('A')).rejects.toMatchObject({ code: 'API_ERROR', status: 3 });
  });
});
