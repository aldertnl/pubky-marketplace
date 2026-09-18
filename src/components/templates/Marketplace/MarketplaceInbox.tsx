'use client';

import { LockKeyhole, MessageCircle } from 'lucide-react';
import { APP_ROUTES, getMarketplaceListingRoute } from '@/app/routes';
import type { MessagingConversationSummary } from '@/application/messaging/messaging';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { useEncryptedInbox } from '@/hooks/useEncryptedInbox/useEncryptedInbox';
import { useMarketplaceInbox } from '@/hooks/useMarketplaceInbox/useMarketplaceInbox';
import { parseConversationAggregateId } from '@/libs/commerce/messaging-contracts';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceEncryptedConversationDialog } from '@/organisms/Marketplace/MarketplaceEncryptedConversationDialog';
import { MarketplaceMessagingEnableDialog } from '@/organisms/Marketplace/MarketplaceMessagingEnableDialog';
import { useAuthStore } from '@/stores/auth/auth.store';

export function MarketplaceInbox() {
  const encrypted = isDurableCommerceMode(getCommerceAdapterMode());

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Messages
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {encrypted
              ? 'End-to-end encrypted listing conversations. History is stored on this device.'
              : 'Private listing conversations and transaction context.'}
          </Typography>
        </div>

        {encrypted ? <EncryptedInbox /> : <SandboxInbox />}
      </Container>
    </ContentLayout>
  );
}

/**
 * Durable modes: real E2EE messaging over Paykit Encrypted Links. Local
 * history renders even without a live session; a live session (Ring grant)
 * gates sending, receiving, and answering queued handshakes.
 */
function EncryptedInbox() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const inbox = useEncryptedInbox();

  if (!currentUserPubky) {
    return (
      <EmptyState
        title="Sign in to see your messages"
        body="Encrypted conversations belong to a signed-in account on this device."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {inbox.status === 'needs-enable' && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-5">
          <div className="flex items-center gap-2">
            <LockKeyhole className="size-5 text-muted-foreground" />
            <Heading level={2} size="md">
              {inbox.receiverProvisioned ? 'Reconnect encrypted messaging' : 'Enable encrypted messaging'}
            </Heading>
          </div>
          <Typography as="p" className="text-sm text-muted-foreground">
            {inbox.receiverProvisioned
              ? 'The messaging session could not be resumed automatically — your sign-in may predate the messaging grant, or the homeserver no longer accepts its session. Approve a fresh connection in Pubky Ring to send and receive; your stored history below stays readable either way.'
              : 'Marketplace messages are end-to-end encrypted and activate automatically for sign-ins made with the current grant. Your sign-in predates the messaging grant, so a one-time Pubky Ring approval is needed to grant the Paykit message tree and publish your encrypted-messaging address so others can reach you.'}
          </Typography>
          <MarketplaceMessagingEnableDialog reconnect={inbox.receiverProvisioned} onEnabled={inbox.refresh} />
        </div>
      )}

      {inbox.status === 'error' && (
        <div className="flex flex-col items-start gap-3">
          <div role="alert" className="w-full rounded-xl border border-destructive/40 p-4">
            {inbox.errorMessage}
          </div>
          <Button variant="secondary" className="rounded-full" onClick={inbox.refresh}>
            Try again
          </Button>
        </div>
      )}

      {inbox.status === 'loading' ? (
        <Skeleton className="h-32 w-full" />
      ) : inbox.conversations.length ? (
        <div className="flex flex-col gap-3">
          <Typography as="p" className="text-xs text-muted-foreground">
            End-to-end encrypted · history stored on this device · both sides must have enabled encrypted messaging. The
            local storage includes the keys that decrypt it — clearing site data deletes both.
          </Typography>
          {inbox.conversations.map((conversation) => (
            <EncryptedConversationRow key={conversation.id} conversation={conversation} />
          ))}
        </div>
      ) : inbox.status === 'ready' ? (
        <EmptyState
          title="No messages yet"
          body="Open a listing and message its seller to begin. Encrypted messages can only reach sellers who have enabled messaging themselves."
        />
      ) : null}
    </div>
  );
}

function EncryptedConversationRow({ conversation }: { conversation: MessagingConversationSummary }) {
  const parsed = parseConversationAggregateId(conversation.conversation_id);
  if (!parsed) return null;
  const { lastMessage, lastQueued } = conversation;
  // The newest item can be a device-locally QUEUED message — say so instead
  // of pretending it was sent.
  const preview =
    lastQueued && (!lastMessage || lastQueued.queued_at > lastMessage.recorded_at)
      ? `Queued: ${lastQueued.body}`
      : lastMessage
        ? `${lastMessage.direction === 'sent' ? 'You: ' : ''}${lastMessage.body}`
        : 'Conversation started — no messages yet';

  return (
    <MarketplaceEncryptedConversationDialog
      sellerPubky={parsed.sellerPubky}
      buyerPubky={parsed.buyerPubky}
      listingId={parsed.listingId}
      counterpartyPubky={conversation.counterparty_pubky}
      trigger={
        <button type="button" className="w-full text-left" aria-label="Open encrypted conversation">
          <Card className="border py-4 transition-colors hover:border-brand/40">
            <CardContent className="flex items-center gap-4 px-4">
              <div className="rounded-full bg-brand/15 p-3 text-brand">
                <LockKeyhole className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <Typography as="p" className="font-semibold">
                  {conversation.counterparty_pubky.slice(0, 10)}…
                </Typography>
                <Typography as="p" className="truncate text-sm text-muted-foreground">
                  {preview}
                </Typography>
              </div>
              {conversation.lastMessage && (
                <time
                  dateTime={new Date(conversation.lastMessage.sent_at).toISOString()}
                  className="text-xs text-muted-foreground"
                >
                  {new Date(conversation.lastMessage.sent_at).toLocaleDateString('en-US')}
                </time>
              )}
            </CardContent>
          </Card>
        </button>
      }
    />
  );
}

/** Sandbox mode: the labeled plaintext prototype transport, unchanged. */
function SandboxInbox() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { conversations, isLoading, error, isSandbox } = useMarketplaceInbox();

  if (!isSandbox) {
    return (
      <EmptyState
        title="Messaging is not available"
        body="This deployment mode has no messaging backend, so there is nothing real to show here."
      />
    );
  }

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/40 p-4">
        {error}
      </div>
    );
  }

  if (!conversations.length) {
    return <EmptyState title="No messages yet" body="Open a listing and message its seller to begin." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <Typography as="p" className="text-xs text-muted-foreground">
        Sandbox messages are not encrypted: they are stored in plaintext in the sandbox service&apos;s memory and are
        readable by whoever runs it. Do not share anything private.
      </Typography>
      {conversations.map((conversation) => {
        const last = conversation.messages.at(-1);
        const counterpart =
          currentUserPubky === conversation.sellerPubky ? conversation.buyerPubky : conversation.sellerPubky;
        const listingRoute = listingRouteFromAggregate(conversation.listingAggregateId);
        return (
          <Link key={conversation.id} href={listingRoute} overrideDefaults>
            <Card className="border py-4 transition-colors hover:border-brand/40">
              <CardContent className="flex items-center gap-4 px-4">
                <div className="rounded-full bg-brand/15 p-3 text-brand">
                  <MessageCircle className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <Typography as="p" className="font-semibold">
                    {counterpart.slice(0, 10)}…
                  </Typography>
                  <Typography as="p" className="truncate text-sm text-muted-foreground">
                    {last?.text ?? 'Conversation started'}
                  </Typography>
                </div>
                <time dateTime={last?.createdAt} className="text-xs text-muted-foreground">
                  {last ? new Date(last.createdAt).toLocaleDateString('en-US') : ''}
                </time>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center">
      <MessageCircle className="mb-3 size-10 text-muted-foreground" />
      <Heading level={2} size="md">
        {title}
      </Heading>
      <Typography as="p" className="mt-2 max-w-lg text-muted-foreground">
        {body}
      </Typography>
    </div>
  );
}

function listingRouteFromAggregate(aggregateId: string): string {
  const value = aggregateId.startsWith('listing:') ? aggregateId.slice('listing:'.length) : '';
  const sellerPubky = value.slice(0, 52);
  const listingId = value.slice(53);
  return sellerPubky && listingId ? getMarketplaceListingRoute(sellerPubky, listingId) : APP_ROUTES.MARKETPLACE;
}
