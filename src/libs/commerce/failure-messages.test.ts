import { describe, expect, it } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode, ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { marketplaceFailureMessage } from './failure-messages';

describe('marketplaceFailureMessage', () => {
  it('keeps action-specific fallbacks for ordinary refusal codes', () => {
    for (const code of ['BAD_REQUEST', 'CONFLICT', 'FORBIDDEN', 'INVALID_COMMAND', 'INVALID_STATE', 'NOT_FOUND']) {
      const result = marketplaceFailureMessage(code, 'SPECIFIC');
      expect(result).toBe('SPECIFIC');
    }
  });

  it('uses the static action fallback for unknown codes', () => {
    expect(marketplaceFailureMessage('SERVER_PRIVATE_CODE', 'Could not place bid')).toBe('Could not place bid');
  });

  it('does not expose prototype properties as messages', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(marketplaceFailureMessage(code, 'F')).toBe('F');
      expect(typeof marketplaceFailureMessage(code, 'F')).toBe('string');
    }
  });

  it('preserves client-authored validation errors but not wire messages', () => {
    const validationError = new AppError({
      category: ErrorCategory.Validation,
      code: ValidationErrorCode.INVALID_INPUT,
      message: 'A checkout group chooses a fulfillment its listing does not publish.',
      service: ErrorService.Marketplace,
      operation: 'checkout',
    });
    expect(marketplaceFailureMessage('INVALID_INPUT', 'Checkout failed.', validationError)).toBe(
      validationError.message,
    );
    expect(
      marketplaceFailureMessage('INVALID_INPUT', 'Checkout failed.', {
        code: 'INVALID_INPUT',
        message: validationError.message,
      }),
    ).toBe('Checkout failed.');

    const serverError = new AppError({
      category: ErrorCategory.Server,
      code: ServerErrorCode.INTERNAL_ERROR,
      message: 'SENTINEL_SERVER_TEXT_failure_messages',
      service: ErrorService.Marketplace,
      operation: 'checkout',
    });
    const clientError = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.CONFLICT,
      message: 'SENTINEL_CLIENT_TEXT_failure_messages',
      service: ErrorService.Marketplace,
      operation: 'checkout',
    });
    expect(marketplaceFailureMessage('INTERNAL_ERROR', 'Checkout failed.', serverError)).toBe('Checkout failed.');
    expect(marketplaceFailureMessage('CONFLICT', 'Checkout failed.', clientError)).toBe('Checkout failed.');
    expect(marketplaceFailureMessage('INVALID_INPUT', 'Checkout failed.', validationError)).toBe(
      validationError.message,
    );
  });
});
