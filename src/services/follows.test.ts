import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FollowsService } from './follows.js';

describe('FollowsService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function requestUrl(callIndex = fetchMock.mock.calls.length - 1): string {
    const call = fetchMock.mock.calls[callIndex][0] as RequestInfo;
    return typeof call === 'string' ? call : call.url;
  }

  it('returns the followed DIDs from the remote AppView', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      follows: [
        { did: 'did:plc:one', handle: 'one.bsky.social' },
        { did: 'did:plc:two', handle: 'two.bsky.social' },
      ],
      cursor: undefined,
    }));

    const svc = new FollowsService('https://public.api.bsky.app');
    const follows = await svc.getFollows('did:plc:viewer');
    expect(follows).toEqual(['did:plc:one', 'did:plc:two']);
    expect(requestUrl()).toContain('/xrpc/app.bsky.graph.getFollows');
    expect(requestUrl()).toContain('actor=did%3Aplc%3Aviewer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches the follow list within the TTL', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ follows: [{ did: 'did:plc:one' }] }));

    const svc = new FollowsService('https://public.api.bsky.app');
    await svc.getFollows('did:plc:viewer');
    const again = await svc.getFollows('did:plc:viewer');

    expect(again).toEqual(['did:plc:one']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not share the cache across distinct viewers', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(
      okResponse({ follows: [{ did: 'did:plc:one' }] }),
    ));

    const svc = new FollowsService('https://public.api.bsky.app');
    await svc.getFollows('did:plc:viewer');
    await svc.getFollows('did:plc:other');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('paginates through cursors and stops at the cap', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({
        follows: [{ did: 'did:plc:one' }],
        cursor: 'next-page',
      }))
      .mockResolvedValueOnce(okResponse({
        follows: [{ did: 'did:plc:two' }],
        cursor: undefined,
      }));

    const svc = new FollowsService('https://public.api.bsky.app');
    const follows = await svc.getFollows('did:plc:viewer');
    expect(follows).toEqual(['did:plc:one', 'did:plc:two']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl()).toContain('cursor=next-page');
  });

  it('propagates remote errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'UpstreamFailure', message: 'boom' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ));

    const svc = new FollowsService('https://public.api.bsky.app');
    await expect(svc.getFollows('did:plc:viewer')).rejects.toThrow('getFollows failed: 500 UpstreamFailure boom');
  });
});
