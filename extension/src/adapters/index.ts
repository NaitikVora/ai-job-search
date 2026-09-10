import { detectAts } from '../detect';
import { ashbyAdapter } from './ashby';
import { genericAdapter } from './generic';
import { greenhouseAdapter } from './greenhouse';
import { leverAdapter } from './lever';
import { linkedinAdapter } from './linkedin';
import type { AtsAdapter } from './types';
import { workdayAdapter } from './workday';

const ADAPTERS: AtsAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  workdayAdapter,
  linkedinAdapter,
];

export function adapterFor(url: string): AtsAdapter {
  const ats = detectAts(url);
  return ADAPTERS.find((a) => a.kind === ats) ?? genericAdapter;
}

export { genericAdapter, greenhouseAdapter, leverAdapter, ashbyAdapter, workdayAdapter, linkedinAdapter };
export type { AtsAdapter, AdapterExtract } from './types';
