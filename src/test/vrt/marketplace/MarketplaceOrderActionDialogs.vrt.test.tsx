// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceOrderActions } from '@/organisms/Marketplace/MarketplaceOrderActions';

// The post-purchase action dialogs: return request, review, shipment
// tracking, and external-refund evidence. These are the forms the buyer and
// seller journeys submit, so each one needs a rendered baseline of its open
// state — the order timelines only baseline the resulting card states.
const fixtures = vi.hoisted(async () => {
  const { createOrderFixture } = await import('@/test/fixtures/commerce/orders');
  return {
    deliveredOrder: createOrderFixture('delivered'),
    paidOrder: createOrderFixture('paid'),
    returnReceivedOrder: createOrderFixture('return_received'),
  };
});

async function openDialog(trigger: { click: () => Promise<void> }) {
  await trigger.click();
  await vi.waitFor(() => {
    if (!document.querySelector('[role="dialog"]')) throw new Error('Dialog has not opened yet.');
  });
}

function ActionsHarness({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">{children}</main>;
}

describe('Marketplace order action dialogs — visual regression', () => {
  it('renders the open return request dialog at desktop viewport', async () => {
    const { deliveredOrder } = await fixtures;

    const screen = await renderForVRT(
      <ActionsHarness>
        <MarketplaceOrderActions order={deliveredOrder} isBuyer canEditReview={false} actOnOrder={async () => false} />
      </ActionsHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Request return' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-order-return-open-desktop');
  });

  it('renders the open return request dialog at mobile viewport', async () => {
    const { deliveredOrder } = await fixtures;

    const screen = await renderForVRT(
      <ActionsHarness>
        <MarketplaceOrderActions order={deliveredOrder} isBuyer canEditReview={false} actOnOrder={async () => false} />
      </ActionsHarness>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await openDialog(screen.getByRole('button', { name: 'Request return' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-order-return-open-mobile');
  });


  it('renders the open review form at desktop viewport', async () => {
    const { deliveredOrder } = await fixtures;

    const screen = await renderForVRT(
      <ActionsHarness>
        <MarketplaceOrderActions order={deliveredOrder} isBuyer canEditReview={false} actOnOrder={async () => false} />
      </ActionsHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Leave review' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-order-review-open-desktop');
  });

  it('renders the open shipment tracking dialog at desktop viewport', async () => {
    const { paidOrder } = await fixtures;

    const screen = await renderForVRT(
      <ActionsHarness>
        <MarketplaceOrderActions
          order={paidOrder}
          isBuyer={false}
          canEditReview={false}
          actOnOrder={async () => false}
        />
      </ActionsHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Add tracking' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-order-ship-open-desktop');
  });

  it('renders the open external refund evidence dialog at desktop viewport', async () => {
    const { returnReceivedOrder } = await fixtures;

    const screen = await renderForVRT(
      <ActionsHarness>
        <MarketplaceOrderActions
          order={returnReceivedOrder}
          isBuyer={false}
          canEditReview={false}
          actOnOrder={async () => false}
        />
      </ActionsHarness>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await openDialog(screen.getByRole('button', { name: 'Record external refund' }));
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('dialog-order-refund-open-desktop');
  });
});
