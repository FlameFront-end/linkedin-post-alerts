import { load } from 'cheerio';
import { minimumPollMs, type ScopedProtection } from './protection.js';
import { plausibleJobTitle } from '../../../../packages/contracts/src/classifier.js';
import type { StateStore } from '../state.js';
import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';
import { LinkedInError } from './errors.js';
import { LinkedInClient } from './client.js';
import type { Settings } from './settings.js';
import type { KnownPosts } from './global-search.js';

export interface JobCard {
  id: string;
  title: string;
  company: string;
  location: string;
  publishedAt: string;
}
export function decodeJobCards(html: string): JobCard[] {
  const $ = load(html);
  const cards = $('[data-entity-urn^="urn:li:jobPosting:"]');
  if (
    !cards.length &&
    !/no matching jobs|no results|0 jobs/i.test($('body').text())
  )
    throw new LinkedInError('response_format');
  const results: JobCard[] = [];
  cards.each((_, element) => {
    const card = $(element);
    const id = card
      .attr('data-entity-urn')
      ?.match(/^urn:li:jobPosting:(\d{6,15})$/)?.[1];
    const title = card.find('.base-search-card__title').text().trim();
    const company = card.find('.base-search-card__subtitle').text().trim();
    const date = card.find('time[datetime]').attr('datetime');
    const timestamp = date ? Date.parse(date) : NaN;
    if (id && title && company && Number.isFinite(timestamp))
      results.push({
        id,
        title,
        company,
        location: card.find('.job-search-card__location').text().trim(),
        publishedAt: new Date(timestamp).toISOString(),
      });
  });
  if (cards.length && !results.length)
    throw new LinkedInError('response_format');
  return results;
}
export function decodeJobDetails(
  html: string,
  card: JobCard,
): Post | undefined {
  const $ = load(html);
  if (
    /no longer accepting applications|больше не принимает|при[её]м заявок.{0,50}прекращ[её]н|вакансия закрыта/i.test(
      $('.top-card-layout, .topcard').text(),
    )
  )
    return;
  const body = $('.show-more-less-html__markup').first();
  if (!body.length) throw new LinkedInError('response_format');
  body.find('br').replaceWith('\n');
  body.find('p,li,h2,h3,h4').prepend('\n');
  const description = body
    .text()
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (description.length < 40) throw new LinkedInError('response_format');
  const parsed = postSchema.safeParse({
    id: `urn:li:jobPosting:${card.id}`,
    kind: 'job',
    title: card.title,
    location: card.location,
    url: `https://www.linkedin.com/jobs/view/${card.id}/`,
    author: card.company,
    text: description,
    publishedAt: card.publishedAt,
    publishedPrecision: 'day',
    firstSeenAt: new Date().toISOString(),
  });
  if (!parsed.success) throw new LinkedInError('response_format');
  return parsed.data;
}

/** Uses the public Jobs entry points. Backoff is independent of the member feed. */
export class LinkedInJobsSource {
  readonly name = 'linkedin-jobs';
  private nextPollAt = 0;
  private offset = 0;
  private readonly cache = new Map<string, { post: Post; expires: number }>();
  private readonly deferred = new Map<string, number>();
  private readonly refreshed = new Map<string, number>();
  private readonly cursors = new Map<number, number>();
  private initialized = false;
  reports: {
    query: number;
    discovered: number;
    posts: number;
    status: string;
  }[] = [];
  constructor(
    private readonly client: LinkedInClient,
    private readonly settings: Settings,
    private readonly known?: KnownPosts,
    private readonly state?: StateStore,
    private readonly protection?: ScopedProtection,
  ) {}
  shouldPoll() {
    return (
      this.settings.jobsKeywords.length > 0 && Date.now() >= this.nextPollAt
    );
  }
  async *fetchBatches(signal?: AbortSignal): AsyncGenerator<Post[]> {
    if (!this.initialized) {
      const saved = await this.state?.load('jobs');
      if (saved && typeof saved === 'object') {
        const value = saved as {
          nextPollAt?: number;
          offset?: number;
          deferred?: [string, number][];
          cursors?: [number, number][];
          refreshed?: [string, number][];
        };
        this.nextPollAt = value.nextPollAt ?? 0;
        this.offset = (value.offset ?? 0) % this.settings.jobsKeywords.length;
        for (const [key, until] of value.deferred ?? [])
          if (until > Date.now()) this.deferred.set(key, until);
        for (const [key, at] of value.refreshed ?? [])
          this.refreshed.set(key, at);
        for (const [key, cursor] of value.cursors ?? [])
          this.cursors.set(key, cursor);
      }
      this.initialized = true;
    }
    if (!this.shouldPoll()) return;
    this.nextPollAt = Date.now() + this.settings.jobsIntervalMs;
    this.reports = [];
    this.client.beginCycle(
      (await this.protection?.budget(this.settings.jobsRequestBudget)) ??
        this.settings.jobsRequestBudget,
    );
    const total = this.settings.jobsKeywords.length;
    const first = this.offset;
    this.offset = (first + Math.min(2, total)) % total;
    for (let query = 0; query < Math.min(2, total); query++) {
      const index = (first + query) % total;
      try {
        let details = 0;
        let failures = 0;
        let discovered = 0;
        let loaded = 0;
        for (let page = 0; page < this.settings.jobsMaxPages; page++) {
          const start = page === 0 ? 0 : (this.cursors.get(index) ?? 10);
          const params = new URLSearchParams({
            keywords: this.settings.jobsKeywords[index]!,
            location: 'Worldwide',
            f_TPR: `r${this.settings.jobsMaxAgeHours * 3600}`,
            sortBy: 'DD',
            start: String(start),
          });
          const html = await this.client.get(
            '/jobs-guest/jobs/api/seeMoreJobPostings/search?' + params,
            signal,
          );
          if (typeof html !== 'string')
            throw new LinkedInError('response_format');
          const allCards = decodeJobCards(html);
          discovered += allCards.length;
          const cards = allCards.filter(
            (card) =>
              Date.parse(card.publishedAt) >=
              Date.now() - this.settings.jobsMaxAgeHours * 3600000,
          );
          const known = this.known
            ? await this.known(
                cards.map((card) => `urn:li:jobPosting:${card.id}`),
              )
            : new Set<string>();
          const posts: Post[] = [];

          let traversed = 0;
          const eligible = cards.filter(
            (card) =>
              plausibleJobTitle(card.title) &&
              (this.deferred.get(card.id) ?? 0) <= Date.now(),
          );
          const unseen = eligible.filter(
            (card) => !known.has(`urn:li:jobPosting:${card.id}`),
          );
          const refresh = eligible
            .filter(
              (card) =>
                known.has(`urn:li:jobPosting:${card.id}`) &&
                (this.refreshed.get(card.id) ?? 0) <= Date.now() - 21600000,
            )
            .sort(
              (a, b) =>
                (this.refreshed.get(a.id) ?? 0) -
                (this.refreshed.get(b.id) ?? 0),
            )
            .slice(0, 1);
          for (const card of unseen.length ? unseen : refresh) {
            if (details >= this.settings.jobsDetailsPerQuery) break;
            traversed = Math.max(traversed, cards.indexOf(card) + 1);
            signal?.throwIfAborted();
            if (!plausibleJobTitle(card.title)) continue;
            if ((this.deferred.get(card.id) ?? 0) > Date.now()) continue;
            const cached = this.cache.get(card.id);
            if (cached && cached.expires > Date.now()) {
              posts.push(cached.post);
              continue;
            }
            if (details >= this.settings.jobsDetailsPerQuery) break;
            details++;
            try {
              const detail = await this.client.get(
                '/jobs-guest/jobs/api/jobPosting/' + card.id,
                signal,
              );
              if (typeof detail !== 'string')
                throw new LinkedInError('response_format');
              const post = decodeJobDetails(detail, card);
              if (post) {
                this.refreshed.set(card.id, Date.now());
                this.cache.set(card.id, {
                  post,
                  expires: Date.now() + 1800000,
                });
                if (this.cache.size > 500)
                  this.cache.delete(this.cache.keys().next().value!);
                posts.push(post);
              } else
                this.deferred.set(
                  card.id,
                  Date.now() +
                    Math.max(
                      3600000,
                      2 *
                        Math.max(
                          minimumPollMs.jobs,
                          this.settings.jobsIntervalMs,
                        ) +
                        60000,
                    ),
                );
            } catch (error) {
              if (
                signal?.aborted ||
                (error instanceof LinkedInError &&
                  [
                    'rate_limited',
                    'auth_required',
                    'budget',
                    'search_restricted',
                    'source_blocked',
                    'request_limit',
                    'protection_pause',
                  ].includes(error.code))
              ) {
                if (posts.length) yield posts;
                throw error;
              }
              if (error instanceof LinkedInError)
                await this.protection?.failure(error);
              failures++;
              this.deferred.set(
                card.id,
                Date.now() +
                  Math.max(
                    1800000,
                    2 *
                      Math.max(
                        minimumPollMs.jobs,
                        this.settings.jobsIntervalMs,
                      ) +
                      60000,
                  ),
              );
            }
          }
          if (!unseen.length) traversed = cards.length;
          loaded += posts.length;
          yield posts;
          if (start > 0)
            this.cursors.set(index, cards.length ? start + traversed : 10);
          else if (!this.cursors.has(index))
            this.cursors.set(index, allCards.length || 10);
          if (!cards.length || details >= this.settings.jobsDetailsPerQuery)
            break;
        }
        this.reports.push({
          query: index,
          discovered,
          posts: loaded,
          status: failures ? 'partial' : 'ok',
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!(error instanceof LinkedInError)) throw error;
        const failure = error;
        await this.protection?.failure(failure);
        if (
          [
            'search_restricted',
            'source_blocked',
            'request_limit',
            'protection_pause',
          ].includes(failure.code)
        ) {
          this.offset = index;
          await this.persist();
          throw failure;
        }
        this.reports.push({
          query: index,
          discovered: 0,
          posts: 0,
          status: failure.code,
        });
        if (
          failure.code === 'rate_limited' ||
          failure.code === 'auth_required'
        ) {
          this.nextPollAt =
            Date.now() +
            Math.max(
              this.settings.jobsIntervalMs,
              failure.retryAfterSeconds * 1000,
            );
          await this.persist();
          return;
        }
        if (failure.code === 'budget') {
          this.offset = index;
          break;
        }
      }
    }
    await this.persist();
  }
  private async persist() {
    for (const [key, until] of this.deferred)
      if (until <= Date.now()) this.deferred.delete(key);
    while (this.deferred.size > 2000)
      this.deferred.delete(this.deferred.keys().next().value!);
    while (this.refreshed.size > 2000)
      this.refreshed.delete(this.refreshed.keys().next().value!);
    await this.state?.save('jobs', {
      nextPollAt: this.nextPollAt,
      offset: this.offset,
      deferred: [...this.deferred],
      cursors: [...this.cursors],
      refreshed: [...this.refreshed],
    });
  }
  async fetchPosts(signal?: AbortSignal) {
    const posts: Post[] = [];
    for await (const batch of this.fetchBatches(signal)) posts.push(...batch);
    return posts;
  }
}
