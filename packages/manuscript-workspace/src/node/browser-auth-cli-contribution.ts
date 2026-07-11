// *****************************************************************************
// CLI contribution for the optional browser-auth gate.
//
//   --auth                     Force the gate on even for loopback peers.
//   --auth-set-password <pw>   Hash <pw> with scrypt and persist it to
//                              ~/.ai-focused-editor/auth.json (a SALTED HASH,
//                              never plaintext), then continue startup.
//
// `setArguments` runs before the BackendApplication's `initialize()`, so the
// force flag is already recorded on the shared configuration by the time the
// gate wires its middleware.
// *****************************************************************************

import * as yargs from '@theia/core/shared/yargs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CliContribution } from '@theia/core/lib/node';
import { BrowserAuthConfiguration } from './browser-auth-configuration';
import { hashPassword, writeCredentialFile, authStorePath } from './browser-auth-crypto';

const LOG_PREFIX = '[browser-auth]';

@injectable()
export class BrowserAuthCliContribution implements CliContribution {

  @inject(BrowserAuthConfiguration)
  protected readonly config!: BrowserAuthConfiguration;

  configure(conf: yargs.Argv): void {
    conf.option('auth', {
      description:
        'Require a shared secret for REMOTE browser connections. When set, even ' +
        'localhost connections are gated. Requires AI_FOCUSED_EDITOR_AUTH_SECRET ' +
        'or a password set via --auth-set-password.',
      type: 'boolean',
      default: false
    });
    conf.option('auth-set-password', {
      description:
        'Hash the given password/token (scrypt) into ~/.ai-focused-editor/auth.json ' +
        'and continue startup. Never stores plaintext.',
      type: 'string'
    });
  }

  setArguments(args: yargs.Arguments): void {
    const setPassword = args['auth-set-password'];
    if (typeof setPassword === 'string' && setPassword.length > 0) {
      writeCredentialFile(hashPassword(setPassword));
      // eslint-disable-next-line no-console
      console.info(`${LOG_PREFIX} stored salted password hash at ${authStorePath()}`);
    }
    this.config.setForceEnabled(args.auth === true);
  }
}
