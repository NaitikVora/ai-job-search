import { logger } from '../log.js';

const log = logger('apollo');
const BASE = 'https://api.apollo.io/api/v1';

export interface ApolloSearchParams {
  /** Company domains (q_organization_domains_list). Preferred: exact and free. */
  domains?: string[];
  /** Free-text fallback when no domain is known. */
  keywords?: string;
  titles: string[];
  seniorities?: string[];
  locations?: string[];
  page?: number;
  perPage?: number;
}

/** What the free People API Search returns: obfuscated last name, no email, no LinkedIn URL. */
export interface ApolloSearchPerson {
  id: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string;
  has_email?: boolean;
  organization?: { name?: string; primary_domain?: string };
}

/** What People Enrichment returns (1 credit when it finds credit-consuming data). */
export interface ApolloPerson {
  id: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  email?: string | null;
  email_status?: string | null;
  linkedin_url?: string | null;
  seniority?: string | null;
  departments?: string[];
  organization?: { name?: string; website_url?: string; primary_domain?: string } | null;
  employment_history?: Array<{ organization_name?: string; title?: string; start_date?: string; end_date?: string | null; current?: boolean }>;
}

export class ApolloClient {
  creditsSpent = 0;

  constructor(private readonly apiKey: string | undefined) {}

  configured(): boolean {
    return Boolean(this.apiKey);
  }

  private async post<T>(pathname: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
    if (!this.apiKey) throw new Error('APOLLO_API_KEY is not set');
    const res = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = 1500 * 2 ** attempt;
      log.warn(`rate limited on ${pathname}, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return this.post<T>(pathname, body, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Apollo ${pathname} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** People API Search: 0 credits. Requires a master API key (or an account registered with a work email on the free plan). */
  async searchPeople(params: ApolloSearchParams): Promise<ApolloSearchPerson[]> {
    const body: Record<string, unknown> = {
      person_titles: params.titles,
      include_similar_titles: true,
      page: params.page ?? 1,
      per_page: Math.min(params.perPage ?? 25, 100),
    };
    if (params.domains?.length) body.q_organization_domains_list = params.domains;
    else if (params.keywords) body.q_keywords = params.keywords;
    if (params.seniorities?.length) body.person_seniorities = params.seniorities;
    if (params.locations?.length) body.person_locations = params.locations;
    const data = await this.post<{ people?: ApolloSearchPerson[]; contacts?: ApolloSearchPerson[] }>(
      '/mixed_people/api_search',
      body,
    );
    return [...(data.people ?? []), ...(data.contacts ?? [])];
  }

  /** People Enrichment by Apollo id: 1 credit when an email is found. Personal emails and phones are never requested. */
  async enrichPerson(id: string): Promise<ApolloPerson | undefined> {
    const data = await this.post<{ person?: ApolloPerson | null }>('/people/match', {
      id,
      reveal_personal_emails: false,
      reveal_phone_number: false,
    });
    const person = data.person ?? undefined;
    if (person?.email) this.creditsSpent += 1;
    return person;
  }
}
