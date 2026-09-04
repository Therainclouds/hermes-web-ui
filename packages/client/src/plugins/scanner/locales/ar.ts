// Re-export English strings until translations land.
// Missing keys fall back to `fallbackLocale: 'en'` at runtime, so this
// stub only needs to exist for the type-checker to resolve the import.
export { default } from './en'
