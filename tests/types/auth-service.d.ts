declare module '*server/crypto.mjs' {
  export const hashPassword: any, verifyPassword: any, base32: any, unbase32: any, hotp: any, matchTotp: any, provisioningUri: any, newTotpSecret: any;
}
declare module '*server/auth-service.mjs' { export const createAuthService: any; }
declare module '*server/store.mjs' { export const MemoryCredentialStore: any, openEncryptedStore: any; }
declare module '*server/ca-verifier.mjs' { export const createCaVerifier: any; }
declare module '*account-auth.mjs' { export const AccountAuthClient: any; }
declare module '*server/ports.mjs' { export const listenOnUsablePort: any, reservedPortSet: any, writePortFile: any; }
