declare module '*web/i18n.mjs' {
  export const CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>>;
  export const LOCALES: readonly { id: string; label: string; name: string }[];
  export const LOCALE_STORAGE_KEY: string;
  export const normalizeLocale: (value: unknown) => string;
  export const getLocale: () => string;
  export function formatDisplayDecimal(value: string, language?: string): string;
  export function decimalUi(value: string): any;
  export function presentation(renderer: (language: string) => string): any;
  export function t(key: string, parameters?: Record<string, unknown>, language?: string): string;
  export function msg(key: string, parameters?: Record<string, unknown>): any;
  export function jsonUi(value: any): any;
  export function renderUi(value: any, language?: string): string;
  export function paint(element: any, value: any): void;
  export function statusUi(value: any): any;
  export function trustedMessage(value: string): any;
  export function translateStatic(root?: any): void;
  export function setLocale(value: unknown, options?: any): string;
  export function initializeLocale(document?: any, storage?: any): void;
}
declare module '*web/native-i18n.mjs' {
  export function translateNative(text: string, language?: string): string;
  export function checkDisplay(values: any): any;
  export function nativeText(text: string): any;
  export function nativeUi(renderer: any, view: any): any;
  export function settlementDisplay(review: any): any;
  export function clearingReviewDisplay(review: any, notes: string): any;
  export function clearingDisplay(observation: any): any;
}
