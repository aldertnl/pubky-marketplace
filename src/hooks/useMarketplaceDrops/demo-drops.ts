import type { DropStreamBucket, NexusDropStreamEntry } from './drops-stream';

/** Local UI fixtures only; never published or registered with a transaction service. */
export function createDemoDrops(now: number): Record<DropStreamBucket, NexusDropStreamEntry[]> {
  const hour = 3_600_000;
  const entry = (
    id: string,
    title: string,
    description: string,
    starts: number,
    ends: number,
  ): NexusDropStreamEntry => ({
    id: `demo-${id}`,
    owner_id: 'demo-studio',
    title,
    description,
    media_urls: [],
    format: 'fixed_price',
    starts_at: new Date(now + starts * hour).toISOString(),
    ends_at: new Date(now + ends * hour).toISOString(),
    total_quantity: 50,
    per_buyer_limit: 1,
  });
  return {
    live: [
      entry(
        'vinyl',
        'After Hours — limited vinyl',
        'A small-run pressing with a numbered sleeve. Demo release for reviewing the marketplace.',
        -1,
        6,
      ),
    ],
    upcoming: [
      entry(
        'print',
        'City Lights — signed print',
        'A numbered art print from an independent studio. Demo release for reviewing the marketplace.',
        4,
        28,
      ),
    ],
    ended: [
      entry(
        'tee',
        'First Edition — studio tee',
        'A limited collection of heavyweight cotton tees. Demo release for reviewing the marketplace.',
        -48,
        -2,
      ),
    ],
  };
}
