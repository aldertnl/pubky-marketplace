import { afterEach, describe, expect, it } from 'vitest';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { PUBKY_RUNTIME_ENV_NAMES } from '@/libs/runtime-config/runtime-config.schema';
import { getWrongEnvironmentHomeserverMessage } from './error.utils';

describe('getWrongEnvironmentHomeserverMessage', () => {
  afterEach(() => {
    delete process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv];
    resetRuntimeConfigForTests();
  });

  it('names the staging account requirement when the deploy is staging', () => {
    process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv] = 'staging';
    resetRuntimeConfigForTests();

    expect(getWrongEnvironmentHomeserverMessage()).toBe(
      'This key is linked to a different homeserver. Use a staging account on this site.',
    );
  });

  it('names the production account requirement when the deploy is production', () => {
    process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv] = 'production';
    resetRuntimeConfigForTests();

    expect(getWrongEnvironmentHomeserverMessage()).toBe(
      'This key is linked to a different homeserver. Use a production account on this site.',
    );
  });
});
