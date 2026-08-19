import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Who is allowed to hand the Judge work, and to create the cohorts that work
 * lands in.
 *
 * Creating a cohort decides which ranking a whole set of teams competes in.
 * Submitting decides what gets judged. Neither is something a learner, a
 * browser, or an unauthenticated caller may do — and the token that permits
 * them is deliberately not the worker's.
 */

const env: { PARTNER_API_TOKEN?: string; WORKER_API_TOKEN?: string } = {};
vi.mock('@/lib/store', () => ({ getEnvConfig: () => env }));

const { isPartnerRequest, partnerUnauthorised } = await import('./partner-auth');

const TOKEN = 'p'.repeat(48);
const request = (auth?: string) =>
  new Request('https://judge.example.test/api/partner/cohorts', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  env.PARTNER_API_TOKEN = TOKEN;
  env.WORKER_API_TOKEN = 'w'.repeat(48);
});

describe('an unauthenticated caller', () => {
  it('cannot sync a cohort or submit work', () => {
    expect(isPartnerRequest(request())).toBe(false);
    expect(isPartnerRequest(request('Bearer '))).toBe(false);
    expect(isPartnerRequest(request('Basic abc'))).toBe(false);
  });

  it('is told nothing about whether the endpoint exists', async () => {
    // 404, not 401: the existence of a partner API is not a fact an
    // unauthenticated caller should be able to confirm.
    const response = partnerUnauthorised();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });
});

describe('a wrong token', () => {
  it('is refused, including one that merely starts correctly', () => {
    expect(isPartnerRequest(request(`Bearer ${'p'.repeat(47)}`))).toBe(false);
    expect(isPartnerRequest(request(`Bearer ${'p'.repeat(49)}`))).toBe(false);
    expect(isPartnerRequest(request('Bearer wrong'))).toBe(false);
  });

  it('does not accept the worker’s token', () => {
    /*
     * The two credentials authorise different callers doing different things:
     * the worker uploads evidence for a job it holds, the internal product
     * submits work and reads results. One secret for both would mean a leak on
     * either side handing over everything.
     */
    expect(isPartnerRequest(request(`Bearer ${env.WORKER_API_TOKEN}`))).toBe(false);
  });
});

describe('a correct token', () => {
  it('is accepted', () => {
    expect(isPartnerRequest(request(`Bearer ${TOKEN}`))).toBe(true);
  });
});

describe('a deployment with no token configured', () => {
  it('refuses everyone rather than accepting anyone', () => {
    // Fail shut. A deployment that forgot to set the secret should decline
    // work, not accept it from whoever asks first.
    env.PARTNER_API_TOKEN = undefined;
    expect(isPartnerRequest(request(`Bearer ${TOKEN}`))).toBe(false);

    env.PARTNER_API_TOKEN = 'too-short';
    expect(isPartnerRequest(request('Bearer too-short'))).toBe(false);
  });
});
