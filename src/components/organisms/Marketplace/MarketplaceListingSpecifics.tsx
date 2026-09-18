'use client';

import { Typography } from '@/atoms/Typography/Typography';
import {
  commerceAttributeLabel,
  commerceAttributeValueLabel,
  commerceCategoryPathLabels,
} from '@/config/taxonomy/taxonomy';
import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';

export interface MarketplaceListingSpecificsProps {
  record: Pick<CommerceListingRecord, 'categoryId' | 'attributes'>;
}

/**
 * The item-specifics table on the listing detail page: the category
 * breadcrumb plus every attribute the record carries. Keys this build's
 * taxonomy knows get their configured labels and vocabulary display values;
 * anything else (records from other clients or newer taxonomies) renders as
 * a prettified label with the raw value — attributes are never dropped.
 */
export function MarketplaceListingSpecifics({ record }: MarketplaceListingSpecificsProps) {
  const attributeEntries = Object.entries(record.attributes ?? {});

  return (
    <div className="flex flex-col gap-2" data-cy="marketplace-listing-specifics">
      <Typography as="p" className="text-sm font-semibold">
        Item specifics
      </Typography>
      <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-6 gap-y-2 rounded-xl border bg-card p-4 text-sm">
        <dt className="text-muted-foreground">Category</dt>
        <dd>{commerceCategoryPathLabels(record.categoryId).join(' › ')}</dd>
        {attributeEntries.map(([key, value]) => (
          <SpecificsRow key={key} attributeKey={key} value={value} />
        ))}
      </dl>
    </div>
  );
}

function SpecificsRow({ attributeKey, value }: { attributeKey: string; value: string | string[] }) {
  const values = Array.isArray(value) ? value : [value];
  return (
    <>
      <dt className="text-muted-foreground">{commerceAttributeLabel(attributeKey)}</dt>
      <dd>{values.map((entry) => commerceAttributeValueLabel(attributeKey, entry)).join(', ')}</dd>
    </>
  );
}
