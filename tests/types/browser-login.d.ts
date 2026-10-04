declare module '*login-core.mjs' {
  export const LOGIN_LIFETIME_MS: number;
  export const CHALLENGE_LIFETIME_MS: number;
  export class WalletLoginError extends Error { code: string; }
  export function loginMessage(challenge: any): string;
  export function verifyLoginSignature(provider: any, challenge: any, signature: string, crypto: any): Promise<string>;
  export class WalletLogin {
    constructor(options: any);
    assert(binding?: any): any;
    capture(): any;
    check(): Promise<any>;
    signIn(provider: any): Promise<any>;
    logout(reason?: string): void;
    provider(): { request(args: any): Promise<any> };
    subscribe(listener: (session: any, reason: string) => void): () => void;
  }
}
