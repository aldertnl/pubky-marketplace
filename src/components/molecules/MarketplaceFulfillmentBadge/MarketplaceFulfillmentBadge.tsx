import { Badge } from '@/atoms/Badge/Badge';
import type { MarketplaceFulfillmentMethod } from '@/libs/commerce/pickup';

/**
 * How a listing reaches the buyer (local pickup design §A1): the public
 * record publishes only THAT pickup is offered — never the meeting point.
 * Renders nothing when the source does not carry the vocabulary (an index
 * row predating it) rather than guessing.
 */
export function MarketplaceFulfillmentBadge({
  methods,
  className,
}: {
  methods: readonly MarketplaceFulfillmentMethod[] | null | undefined;
  className?: string;
}) {
  if (!methods || methods.length === 0) return null;
  const offersPickup = methods.includes('pickup');
  const offersShipping = methods.includes('shipping');
  const label = offersPickup ? (offersShipping ? 'Pickup or shipping' : 'Local pickup') : 'Shipping';
  return (
    <Badge variant="secondary" className={className}>
      {label}
    </Badge>
  );
}
