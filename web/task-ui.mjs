import { mountTaskAuthorization } from './task-authorization-ui.mjs';
import { walletLogin, currentAccountClient } from './wallet-auth.mjs';
mountTaskAuthorization({ document, window: globalThis, walletLogin, getClient: currentAccountClient });
