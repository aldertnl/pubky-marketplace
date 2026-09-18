'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

export type UsePackingSlipAddressResult = {
  /** The pasted delivery address, or '' when nothing is staged. */
  address: string;
  /** Stage the next value (wire to the textarea's onChange). */
  setAddress: (next: string) => void;
  /** Drop the staged address (the dialog calls this on close). */
  clear: () => void;
};

/**
 * Local-only staging for a delivery address the seller pastes into the
 * packing slip so it prints on the slip instead of being hand-copied.
 *
 * PRIVACY INVARIANT: the value lives ONLY in this component state. It is
 * never persisted (no Dexie, no localStorage/sessionStorage, no URL), never
 * logged, and never sent anywhere — it exists only so `window.print()` can
 * put it on paper. It is cleared on print completion and on route change;
 * the dialog clears it on close.
 *
 * This does not weaken the delivery-address boundary (ADR-0019 §8,
 * docs/ecommerce/shipping.md): the address still never comes from a
 * transaction-service read. The seller obtains it from the buyer directly
 * (e.g. the encrypted conversation) and pastes it here for one print job.
 */
export function usePackingSlipAddress(): UsePackingSlipAddressResult {
  const [address, setAddress] = useState('');
  const pathname = usePathname();

  // Route change: the address must not outlive the screen it was pasted on.
  // This also fires on mount, which is a no-op against the initial ''.
  useEffect(() => {
    setAddress('');
  }, [pathname]);

  // Print completion: the address's only job was the printed slip.
  useEffect(() => {
    const clearAfterPrint = () => setAddress('');
    window.addEventListener('afterprint', clearAfterPrint);
    return () => window.removeEventListener('afterprint', clearAfterPrint);
  }, []);

  const clear = () => setAddress('');

  return { address, setAddress, clear };
}
