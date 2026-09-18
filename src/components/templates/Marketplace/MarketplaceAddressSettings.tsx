'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import {
  bareDeliveryAddressId,
  useMarketplaceAddressBook,
} from '@/hooks/useMarketplaceAddressBook/useMarketplaceAddressBook';
import {
  type MarketplaceAddressFormData,
  marketplaceAddressFormDefaults,
  marketplaceAddressFormSchema,
} from '@/hooks/useMarketplaceAddressBook/useMarketplaceAddressBook.types';
import type { CommerceDeliveryAddressModelSchema } from '@/models/commerce/commerce.schema';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';

export function MarketplaceAddressSettings() {
  const { addresses, isLoading, save, remove, setDefault } = useMarketplaceAddressBook();
  // null: list only; 'new': creating; otherwise the composite id being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const form = useForm<MarketplaceAddressFormData>({
    resolver: zodResolver(marketplaceAddressFormSchema),
    defaultValues: marketplaceAddressFormDefaults,
    mode: 'onChange',
  });

  const beginCreate = () => {
    form.reset(marketplaceAddressFormDefaults);
    setEditingId('new');
  };

  const beginEdit = (address: CommerceDeliveryAddressModelSchema) => {
    form.reset({
      label: address.label,
      name: address.name,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      region: address.region,
      postalCode: address.postal_code,
      countryCode: address.country_code,
    });
    setEditingId(address.id);
  };

  const submit = form.handleSubmit(async (data) => {
    const editing = addresses.find(({ id }) => id === editingId);
    if (await save(editing ? bareDeliveryAddressId(editing) : null, data)) {
      form.reset(marketplaceAddressFormDefaults);
      setEditingId(null);
    }
  });

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
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Badge className="mb-4">Private to this device</Badge>
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              Delivery addresses
            </Heading>
            <Typography as="p" className="mt-2 max-w-xl text-muted-foreground">
              These are your delivery addresses for purchases you make; sellers never see them.
            </Typography>
          </div>
          {editingId === null && (
            <Button className="rounded-full" onClick={beginCreate}>
              <Plus className="mr-2 size-4" />
              Add address
            </Button>
          )}
        </div>

        {editingId !== null && (
          <Card className="border">
            <CardContent className="grid gap-4 px-6">
              <Typography as="h2" className="text-xl font-semibold">
                {editingId === 'new' ? 'New address' : 'Edit address'}
              </Typography>
              <ControlledInputField name="label" control={form.control} label="Label" placeholder="Home" />
              <ControlledInputField name="name" control={form.control} label="Recipient" />
              <ControlledInputField name="line1" control={form.control} label="Address line 1" />
              <ControlledInputField name="line2" control={form.control} label="Address line 2" />
              <div className="grid gap-4 sm:grid-cols-2">
                <ControlledInputField name="city" control={form.control} label="City" />
                <ControlledInputField name="region" control={form.control} label="Region" />
                <ControlledInputField name="postalCode" control={form.control} label="Postal code" />
                <ControlledInputField name="countryCode" control={form.control} label="Country" />
              </div>
              <div className="flex gap-2">
                <Button className="rounded-full" onClick={() => void submit()}>
                  Save address
                </Button>
                <Button variant="secondary" className="rounded-full" onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : addresses.length ? (
          <div className="grid gap-3">
            {addresses.map((address) => (
              <Card key={address.id} className="border py-4">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Typography as="h2" className="font-semibold">
                        {address.label}
                      </Typography>
                      {address.is_default && <Badge variant="secondary">Default</Badge>}
                    </div>
                    <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                      {address.name} · {address.line1}
                      {address.line2 ? `, ${address.line2}` : ''}, {address.city}, {address.region}{' '}
                      {address.postal_code}, {address.country_code}
                    </Typography>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!address.is_default && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-full"
                        onClick={() => void setDefault(address)}
                      >
                        <Star className="mr-1 size-4" />
                        Make default
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="rounded-full"
                      aria-label={`Edit ${address.label}`}
                      onClick={() => beginEdit(address)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="rounded-full"
                      aria-label={`Delete ${address.label}`}
                      onClick={() => void remove(address)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : editingId === null ? (
          <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed text-center">
            <MapPin className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              No saved addresses
            </Heading>
            <Typography as="p" className="mt-2 max-w-md text-sm text-muted-foreground">
              Save an address here or during checkout, and the cart&apos;s address picker will offer it next time.
            </Typography>
          </div>
        ) : null}
      </Container>
    </ContentLayout>
  );
}
