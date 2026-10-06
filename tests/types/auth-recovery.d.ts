declare module '*server/recovery-service.mjs' { export const createRecoveryService: any, RecoveryError: any; }
declare module '*server/mail-otp.mjs' { export const createSmtpOtpSender: any, createOtpSenderFromEnvironment: any, normalizeEmail: any, OTP_FROM: string, OTP_HOST: string; }
